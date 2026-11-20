package dev.birdwatch.sdk;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.SystemClock;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import java.io.Closeable;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.function.DoubleSupplier;
import java.util.function.LongSupplier;
import org.json.JSONArray;

/** Native Android analytics. Keep one client alive per collector/project for the app's lifetime. */
public final class Birdwatch implements Closeable {
  public static final class Receipt {
    private final String id;
    private final int accepted, duplicates;

    Receipt(String id, int accepted, int duplicates) {
      this.id = id;
      this.accepted = accepted;
      this.duplicates = duplicates;
    }

    @NonNull
    public String getId() {
      return id;
    }

    public int getAccepted() {
      return accepted;
    }

    public int getDuplicates() {
      return duplicates;
    }
  }

  public static final class Builder {
    private final Context context;
    private final String host, writeKey;
    private int maxQueueSize = 1000, timeoutMillis = 5000;
    Collector.Transport transport = Collector::http;
    LongSupplier wall = System::currentTimeMillis, elapsed = SystemClock::elapsedRealtime;
    DoubleSupplier jitter = () -> ThreadLocalRandom.current().nextDouble();
    long flushInterval = 150;
    Timer timer =
        (state, run, ms) -> {
          java.util.concurrent.Future<?> future = state.schedule(run, ms, TimeUnit.MILLISECONDS);
          return () -> future.cancel(false);
        };
    private Consumer<Throwable> onError = ignored -> {};

    public Builder(@NonNull Context context, @NonNull String host, @NonNull String writeKey) {
      this.context =
          java.util.Objects.requireNonNull(context.getApplicationContext(), "applicationContext");
      this.host = java.util.Objects.requireNonNull(host, "host");
      this.writeKey = Event.field(writeKey, "writeKey", 128);
    }

    @NonNull
    public Builder maxQueueSize(int count) {
      if (count < 1 || count > 100000)
        throw new IllegalArgumentException("maxQueueSize must be 1–100000");
      maxQueueSize = count;
      return this;
    }

    @NonNull
    public Builder timeoutMillis(int ms) {
      if (ms < 1 || ms > 120000)
        throw new IllegalArgumentException("timeoutMillis must be 1–120000");
      timeoutMillis = ms;
      return this;
    }

    /** Receives storage and automatic delivery failures on a worker thread. */
    @NonNull
    public Builder onError(@NonNull Consumer<Throwable> handler) {
      onError = java.util.Objects.requireNonNull(handler);
      return this;
    }

    @NonNull
    public Birdwatch build() {
      return new Birdwatch(this);
    }
  }

  private static final class Pending {
    final Outbox.Row row;
    final List<CompletableFuture<Receipt>> receipts = new ArrayList<>();

    Pending(Outbox.Row row) {
      this.row = row;
    }
  }

  private static final class Barrier {
    final long through;
    final CompletableFuture<Void> result;

    Barrier(long through, CompletableFuture<Void> result) {
      this.through = through;
      this.result = result;
    }
  }

  interface Timer {
    Runnable after(ScheduledThreadPoolExecutor state, Runnable task, long delay);
  }

  private final Builder settings;
  private final Consumer<Throwable> onError;
  private final Collector collector;
  private final Outbox outbox;
  private final ScheduledThreadPoolExecutor state =
      new ScheduledThreadPoolExecutor(1, runnable -> new Thread(runnable, "Birdwatch-storage"));
  private final ExecutorService io =
      Executors.newFixedThreadPool(2, runnable -> new Thread(runnable, "Birdwatch-network"));
  private final TreeMap<Long, Pending> waiting = new TreeMap<>();
  private final List<Barrier> barriers = new ArrayList<>();
  private final Runnable unregisterBackground;
  private ConnectivityManager manager;
  private ConnectivityManager.NetworkCallback listener;
  private Runnable cancel;
  private boolean accepting = true, paused, stopped;
  private final List<Attempt> active = new ArrayList<>(2);
  private final List<Outbox.Row> retry = new ArrayList<>();
  final CompletableFuture<Void> closed = new CompletableFuture<>();
  private long retryAt, backoff = 1000;

  @NonNull
  public static Birdwatch open(
      @NonNull Context context, @NonNull String host, @NonNull String writeKey) {
    return new Builder(context, host, writeKey).build();
  }

  private Birdwatch(Builder builder) {
    settings = builder;
    onError = builder.onError;
    collector =
        new Collector(builder.host, builder.writeKey, builder.timeoutMillis, builder.transport);
    String scope =
        new JSONArray().put(collector.endpoint.toString()).put(builder.writeKey).toString();
    outbox =
        new Outbox(
            builder.context,
            scope,
            builder.maxQueueSize,
            this::report,
            this::corrupt,
            this::evicted);
    unregisterBackground = Background.observe(builder.context, () -> post(() -> send(true)));
    state.setRemoveOnCancelPolicy(true);
    state.execute(
        () -> {
          try {
            manager =
                (ConnectivityManager)
                    builder.context.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (manager != null) {
              listener =
                  new ConnectivityManager.NetworkCallback() {
                    @Override
                    public void onAvailable(Network network) {
                      post(() -> send(false));
                    }
                  };
              manager.registerDefaultNetworkCallback(listener);
            }
          } catch (RuntimeException e) {
            listener = null;
            report(e);
          }
          schedule(settings.flushInterval);
        });
  }

  /** Local commit receipt. Safe to await while offline. */
  @NonNull
  public CompletableFuture<String> enqueue(@NonNull Event event) {
    return local(
        () -> {
          Outbox.Row row = outbox.put(event);
          schedule(settings.flushInterval);
          return row.id;
        });
  }

  @NonNull
  public CompletableFuture<String> enqueue(
      @NonNull String name, @Nullable Map<String, ?> properties) {
    return enqueue(new Event(name, properties));
  }

  @NonNull
  public CompletableFuture<String> enqueue(@NonNull String name) {
    return enqueue(name, Collections.emptyMap());
  }

  /** Collector receipt. A failed request leaves the committed event eligible for replay. */
  @NonNull
  public CompletableFuture<Receipt> capture(@NonNull Event event) {
    return submit(result -> capture(event, result));
  }

  private void capture(Event event, CompletableFuture<Receipt> result) {
    Outbox.Row row = outbox.put(event);
    if (paused) {
      result.completeExceptionally(new IllegalStateException("Delivery paused for unknown key"));
      return;
    }
    waiting.computeIfAbsent(row.sequence, ignored -> new Pending(row)).receipts.add(result);
    schedule(settings.flushInterval);
  }

  @NonNull
  public CompletableFuture<Receipt> capture(
      @NonNull String name, @Nullable Map<String, ?> properties) {
    return capture(new Event(name, properties));
  }

  @NonNull
  public CompletableFuture<Receipt> capture(@NonNull String name) {
    return capture(name, Collections.emptyMap());
  }

  @NonNull
  public CompletableFuture<Receipt> screen(@NonNull String name) {
    long when = settings.wall.getAsLong();
    String id = UUID.randomUUID().toString();
    return submit(
        result ->
            capture(
                new Event(
                    "screen_view",
                    Collections.singletonMap("screen", Event.field(name, "screen", 256)),
                    id,
                    when),
                result));
  }

  @NonNull
  public CompletableFuture<Void> identify(@NonNull String person) {
    return local(
        () -> {
          outbox.identify(Event.field(person, "distinctId", 256));
          return null;
        });
  }

  @NonNull
  public CompletableFuture<String> reset() {
    return local(
        () -> {
          String id = UUID.randomUUID().toString();
          outbox.identify(id);
          return id;
        });
  }

  @NonNull
  public CompletableFuture<String> distinctId() {
    return local(() -> outbox.identity());
  }

  /** Wait for events already committed at this call's position in the local queue. */
  @NonNull
  public CompletableFuture<Void> flush() {
    return submit(
        result -> {
          if (paused) {
            result.completeExceptionally(
                new IllegalStateException("Delivery paused for unknown key"));
            return;
          }
          long last = outbox.lastSequence();
          if (!waiting.isEmpty()) last = Math.max(last, waiting.lastKey());
          if (last == 0) {
            result.complete(null);
            return;
          }
          barriers.add(new Barrier(last, result));
          send(false);
        });
  }

  CompletableFuture<Integer> activeAttempts() {
    return local(active::size);
  }

  private <T> CompletableFuture<T> local(Callable<T> task) {
    return submit(result -> result.complete(task.call()));
  }

  private interface Operation<T> {
    void run(CompletableFuture<T> result) throws Exception;
  }

  private synchronized <T> CompletableFuture<T> submit(Operation<T> task) {
    CompletableFuture<T> result = new CompletableFuture<>();
    if (!accepting) {
      result.completeExceptionally(new IllegalStateException("Birdwatch client is closed"));
      return result;
    }
    state.execute(
        () -> {
          try {
            task.run(result);
          } catch (Exception e) {
            result.completeExceptionally(e);
            report(e);
          }
        });
    return result;
  }

  private void post(Runnable task) {
    try {
      state.execute(
          () -> {
            if (!stopped) task.run();
          });
    } catch (RejectedExecutionException ignored) {
      /* Client has closed. */
    }
  }

  private void report(Throwable e) {
    try {
      onError.accept(e);
    } catch (RuntimeException ignored) {
      /* Observers cannot interrupt delivery. */
    }
  }

  private void schedule(long ms) {
    if (cancel == null && !paused && !stopped)
      cancel = settings.timer.after(state, () -> send(false), Math.max(0, ms));
  }

  private void cancelTimer() {
    if (cancel != null) cancel.run();
    cancel = null;
  }

  private static final class Attempt {
    final List<Outbox.Row> rows;
    final java.util.Set<Long> pending = new java.util.HashSet<>();

    Attempt(List<Outbox.Row> rows) {
      this.rows = rows;
      for (Outbox.Row row : rows) pending.add(row.sequence);
    }
  }

  private void corrupt(Throwable error) {
    active.clear();
    retry.clear();
    while (!waiting.isEmpty()) settle(waiting.firstKey(), null, error);
    settleBarriers(Long.MAX_VALUE, error);
    report(error);
  }

  private void evicted(long through) {
    IllegalStateException error = new IllegalStateException("Outbox full; event was dropped");
    while (!waiting.isEmpty() && waiting.firstKey() <= through)
      settle(waiting.firstKey(), null, error);
    retry.removeIf(row -> row.sequence <= through);
    for (Attempt a : active) a.pending.removeIf(seq -> seq <= through);
  }

  private List<Outbox.Row> nextBatch() {
    if (!retry.isEmpty()) return new ArrayList<>(retry);
    List<Outbox.Row> rows = outbox.batch();
    Map.Entry<Long, Pending> oldest = waiting.firstEntry();
    // Replay a missing waiting row so a second client cannot strand its receipt.
    if (oldest != null && (rows.isEmpty() || oldest.getKey() < rows.get(0).sequence))
      return Collections.singletonList(oldest.getValue().row);
    return collector.fit(rows);
  }

  private void send(boolean background) {
    cancelTimer();
    if (paused || stopped || active.size() >= (background ? 2 : 1)) return;
    long delay = retryAt - settings.elapsed.getAsLong();
    if (delay > 0) {
      schedule(delay);
      return;
    }
    try {
      List<Outbox.Row> batch = nextBatch();
      settleBarriers(batch.isEmpty() ? Long.MAX_VALUE : batch.get(0).sequence, null);
      if (batch.isEmpty()) return;
      Attempt attempt = new Attempt(batch);
      active.add(attempt);
      io.execute(
          () -> {
            Collector.Result ack = collector.attempt(batch, settings.wall.getAsLong());
            post(() -> finish(attempt, ack));
          });
    } catch (RuntimeException e) {
      report(e);
      settleBarriers(Long.MAX_VALUE, e);
      schedule(1000);
    }
  }

  private void finish(Attempt attempt, Collector.Result ack) {
    if (!active.remove(attempt) || attempt.pending.isEmpty()) {
      send(false);
      return;
    }
    if (ack.terminal) {
      try {
        outbox.acknowledge(attempt.rows);
      } catch (RuntimeException e) {
        report(e);
        ack = Collector.Result.failed(e);
      }
    }
    for (int i = 0; i < attempt.rows.size(); i++) {
      Outbox.Row row = attempt.rows.get(i);
      if (!attempt.pending.contains(row.sequence)) continue;
      Exception error = ack.error == null ? ack.rejected.get(i) : ack.error;
      if (ack.terminal) {
        retry.removeIf(r -> r.sequence == row.sequence);
        for (Attempt other : active) other.pending.remove(row.sequence);
        if (ack.error == null && error != null) report(error);
      } else if (active.stream().anyMatch(other -> other.pending.contains(row.sequence))) {
        continue;
      } else if (retry.stream().noneMatch(r -> r.sequence == row.sequence)) retry.add(row);
      settle(
          row.sequence,
          error == null ? new Receipt(row.id, ack.accepted, ack.duplicates) : null,
          error);
    }
    if (ack.error != null) settleBarriers(Long.MAX_VALUE, ack.error);
    if (ack.error != null && (ack.terminal || (ack.pause && !paused))) report(ack.error);
    paused |= ack.pause;
    if (paused) return;
    if (ack.terminal && retry.isEmpty()) {
      backoff = 1000;
      retryAt = 0;
    }
    if (!ack.terminal && !retry.isEmpty()) {
      long delay =
          ack.retryAfter >= 0 ? ack.retryAfter : (long) (settings.jitter.getAsDouble() * backoff);
      retryAt = settings.elapsed.getAsLong() + delay;
      backoff = Math.min(60000, backoff * 2);
    }
    send(false);
  }

  private void settle(long sequence, Receipt receipt, Throwable error) {
    Pending pending = waiting.remove(sequence);
    if (pending == null) return;
    for (CompletableFuture<Receipt> future : pending.receipts) {
      if (error == null) future.complete(receipt);
      else future.completeExceptionally(error);
    }
  }

  private void settleBarriers(long firstRemaining, Throwable error) {
    Iterator<Barrier> it = barriers.iterator();
    while (it.hasNext()) {
      Barrier barrier = it.next();
      if (error != null || barrier.through < firstRemaining) {
        it.remove();
        if (error == null) barrier.result.complete(null);
        else barrier.result.completeExceptionally(error);
      }
    }
  }

  /** Stop collecting and release resources. Previously accepted local writes finish in order. */
  @Override
  public synchronized void close() {
    if (!accepting) return;
    accepting = false;
    state.execute(
        () -> {
          stopped = true;
          cancelTimer();
          if (listener != null) {
            try {
              manager.unregisterNetworkCallback(listener);
            } catch (RuntimeException e) {
              report(e);
            }
          }
          unregisterBackground.run();
          IllegalStateException closed = new IllegalStateException("Birdwatch client is closed");
          while (!waiting.isEmpty()) settle(waiting.firstKey(), null, closed);
          settleBarriers(Long.MAX_VALUE, closed);
          io.shutdown();
          outbox.close();
          state.shutdown();
          this.closed.complete(null);
        });
  }
}

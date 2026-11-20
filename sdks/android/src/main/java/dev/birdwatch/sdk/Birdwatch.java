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
  private int generation, active;
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
            seq -> settle(seq, null, new IllegalStateException("Outbox full; event was dropped")));
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
    return submit(
        result -> {
          Event event =
              new Event(
                  "screen_view",
                  Collections.singletonMap("screen", Event.field(name, "screen", 256)));
          capture(event, result);
        });
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
    return local(() -> active);
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

  // Storage state stays on one executor. Backgrounding can supersede a held request once.
  private void send(boolean background) {
    cancelTimer();
    if (paused || stopped || (active != 0 && (!background || active >= 2))) return;
    long delay = retryAt - settings.elapsed.getAsLong();
    if (delay > 0) {
      schedule(delay);
      return;
    }
    try {
      TreeMap<Long, Outbox.Row> next = new TreeMap<>();
      for (Outbox.Row row : outbox.batch()) next.put(row.sequence, row);
      for (Pending p : waiting.values()) {
        if (next.size() >= 100 && p.row.sequence > next.lastKey()) break;
        next.putIfAbsent(p.row.sequence, p.row);
      }
      settleBarriers(next.isEmpty() ? Long.MAX_VALUE : next.firstKey(), null);
      if (next.isEmpty()) return;
      List<Outbox.Row> batch = collector.fit(new ArrayList<>(next.values()));
      int attempt = ++generation;
      active++;
      io.execute(
          () -> {
            try {
              Collector.Result ack = collector.send(batch, settings.wall.getAsLong());
              post(() -> finish(attempt, batch, ack, null));
            } catch (Exception e) {
              post(() -> finish(attempt, batch, null, e));
            }
          });
    } catch (RuntimeException e) {
      report(e);
      settleBarriers(Long.MAX_VALUE, e);
      schedule(1000);
    }
  }

  private void finish(
      int attempt, List<Outbox.Row> batch, Collector.Result ack, Exception failure) {
    active--;
    if (attempt != generation) {
      send(false);
      return;
    }
    Collector.Failure http =
        failure instanceof Collector.Failure ? (Collector.Failure) failure : null;
    if (failure == null || (http != null && http.terminal)) {
      try {
        outbox.acknowledge(batch);
      } catch (RuntimeException e) {
        failure = e;
        ack = null;
        http = null;
        report(e);
      }
    }
    for (int i = 0; i < batch.size(); i++) {
      Outbox.Row row = batch.get(i);
      Exception error = ack == null ? failure : ack.rejected.get(i);
      if (ack != null && error != null) report(error);
      settle(
          row.sequence,
          error == null ? new Receipt(row.id, ack.accepted, ack.duplicates) : null,
          error);
    }
    if (http != null && (http.pause || http.terminal)) report(http);
    if (failure != null) settleBarriers(Long.MAX_VALUE, failure);
    paused = http != null && http.pause;
    if (paused) return;
    if (failure != null && (http == null || !http.terminal)) {
      long delay =
          http != null && http.retryAfter >= 0
              ? http.retryAfter
              : (long) (settings.jitter.getAsDouble() * backoff);
      backoff = Math.min(60000, backoff * 2);
      retryAt = settings.elapsed.getAsLong() + delay;
      cancelTimer();
      schedule(delay);
    } else {
      retryAt = 0;
      backoff = 1000;
      send(false);
    }
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

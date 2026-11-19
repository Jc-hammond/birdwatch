package dev.birdwatch.sdk;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.SystemClock;
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
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
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
    private Consumer<Throwable> onError = ignored -> {};

    public Builder(Context context, String host, String writeKey) {
      this.context =
          java.util.Objects.requireNonNull(context.getApplicationContext(), "applicationContext");
      this.host = java.util.Objects.requireNonNull(host, "host");
      this.writeKey = Event.field(writeKey, "writeKey", 128);
    }

    public Builder maxQueueSize(int count) {
      if (count < 1 || count > 100000)
        throw new IllegalArgumentException("maxQueueSize must be 1–100000");
      maxQueueSize = count;
      return this;
    }

    public Builder timeoutMillis(int ms) {
      if (ms < 1 || ms > 120000)
        throw new IllegalArgumentException("timeoutMillis must be 1–120000");
      timeoutMillis = ms;
      return this;
    }

    /** Receives storage and automatic delivery failures on a worker thread. */
    public Builder onError(Consumer<Throwable> handler) {
      onError = java.util.Objects.requireNonNull(handler);
      return this;
    }

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

  private final Context context;
  private final Collector collector;
  private final String scope, writeKey;
  private final int capacity;
  private final Consumer<Throwable> onError;
  private final ScheduledThreadPoolExecutor state =
      new ScheduledThreadPoolExecutor(1, runnable -> new Thread(runnable, "Birdwatch-storage"));
  private final ExecutorService io =
      Executors.newSingleThreadExecutor(runnable -> new Thread(runnable, "Birdwatch-network"));
  private boolean accepting = true; // guarded by this
  // The remaining mutable state belongs to the storage executor.
  private final TreeMap<Long, Pending> waiting = new TreeMap<>();
  private final List<Barrier> barriers = new ArrayList<>();
  private Outbox outbox;
  private ConnectivityManager manager;
  private ConnectivityManager.NetworkCallback listener;
  private ScheduledFuture<?> timer;
  private boolean sending, stopped;
  private long retryAt, serverRetryAt, backoff = 1000;

  public static Birdwatch open(Context context, String host, String writeKey) {
    return new Builder(context, host, writeKey).build();
  }

  private Birdwatch(Builder builder) {
    context = builder.context;
    writeKey = builder.writeKey;
    capacity = builder.maxQueueSize;
    collector = new Collector(builder.host, builder.timeoutMillis);
    scope = new JSONArray().put(collector.endpoint.toString()).put(writeKey).toString();
    onError = builder.onError;
    state.setRemoveOnCancelPolicy(true);
    state.execute(
        () -> {
          try {
            manager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (manager != null) {
              listener =
                  new ConnectivityManager.NetworkCallback() {
                    @Override
                    public void onAvailable(Network network) {
                      postInternal(
                          () -> {
                            retryAt = 0;
                            cancelTimer();
                            pump();
                          });
                    }
                  };
              manager.registerDefaultNetworkCallback(listener);
            }
          } catch (RuntimeException e) {
            listener = null;
            report(e);
          }
          pump();
        });
  }

  /** Local commit receipt. Safe to await while offline. */
  public CompletableFuture<String> enqueue(Event event) {
    return local(
        () -> {
          Outbox.Row row = store().put(event);
          pump();
          return row.id;
        });
  }

  public CompletableFuture<String> enqueue(String name, Map<String, ?> properties) {
    return enqueue(new Event(name, properties));
  }

  public CompletableFuture<String> enqueue(String name) {
    return enqueue(name, Collections.emptyMap());
  }

  /** Collector receipt. A failed request leaves the committed event eligible for replay. */
  public CompletableFuture<Receipt> capture(Event event) {
    return submit(
        result -> {
          Outbox.Row row = store().put(event);
          waiting.computeIfAbsent(row.sequence, ignored -> new Pending(row)).receipts.add(result);
          pump();
        });
  }

  public CompletableFuture<Receipt> capture(String name, Map<String, ?> properties) {
    return capture(new Event(name, properties));
  }

  public CompletableFuture<Receipt> capture(String name) {
    return capture(name, Collections.emptyMap());
  }

  public CompletableFuture<Receipt> screen(String name) {
    return capture(
        "screen_view", Collections.singletonMap("screen", Event.field(name, "screen", 256)));
  }

  public CompletableFuture<Void> identify(String person) {
    String valid = Event.field(person, "distinctId", 256);
    return local(
        () -> {
          store().identify(valid);
          return null;
        });
  }

  public CompletableFuture<String> reset() {
    return local(
        () -> {
          String id = UUID.randomUUID().toString();
          store().identify(id);
          return id;
        });
  }

  public CompletableFuture<String> distinctId() {
    return local(() -> store().identity());
  }

  /** Wait for events already committed at this call's position in the local queue. */
  public CompletableFuture<Void> flush() {
    return submit(
        result -> {
          long last = store().lastSequence();
          if (last == 0) {
            result.complete(null);
            return;
          }
          barriers.add(new Barrier(last, result));
          retryAt = 0;
          cancelTimer();
          pump();
        });
  }

  private Outbox store() {
    if (outbox == null) outbox = new Outbox(context, scope, writeKey, capacity);
    return outbox;
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

  private void postInternal(Runnable task) {
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

  private void cancelTimer() {
    if (timer != null) {
      timer.cancel(false);
      timer = null;
    }
  }

  private void schedule(long delay) {
    if (timer == null && !stopped) {
      timer =
          state.schedule(
              () -> {
                timer = null;
                pump();
              },
              Math.max(1, delay),
              TimeUnit.MILLISECONDS);
    }
  }

  private void pump() {
    if (stopped || sending) return;
    try {
      Outbox.Row next = store().first();
      // Another process may already have removed a row. Ask for its actual receipt.
      Map.Entry<Long, Pending> waiter = waiting.firstEntry();
      if (waiter != null && (next == null || waiter.getKey() < next.sequence))
        next = waiter.getValue().row;
      settleBarriers(next == null ? Long.MAX_VALUE : next.sequence);
      if (next == null) {
        cancelTimer();
        return;
      }
      long delay = Math.max(retryAt, serverRetryAt) - SystemClock.elapsedRealtime();
      if (delay > 0) {
        schedule(delay);
        return;
      }
      cancelTimer();
      sending = true;
      final Outbox.Row row = next;
      io.execute(
          () -> {
            try {
              Receipt ack = collector.send(row);
              postInternal(() -> finish(row, ack, null));
            } catch (Exception e) {
              postInternal(() -> finish(row, null, e));
            }
          });
    } catch (RuntimeException e) {
      sending = false;
      defer(e);
    }
  }

  private void settleBarriers(long firstRemaining) {
    Iterator<Barrier> it = barriers.iterator();
    while (it.hasNext()) {
      Barrier b = it.next();
      if (b.through < firstRemaining) {
        it.remove();
        b.result.complete(null);
      }
    }
  }

  private void finish(Outbox.Row row, Receipt receipt, Exception error) {
    sending = false;
    Collector.HttpFailure http =
        error instanceof Collector.HttpFailure ? (Collector.HttpFailure) error : null;
    if (error != null && (http == null || (http.status != 400 && http.status != 413))) {
      if (http != null && (http.status == 429 || http.status == 503)) {
        serverRetryAt = SystemClock.elapsedRealtime() + http.delayMillis;
      }
      defer(error);
      return;
    }
    try {
      store().remove(row);
    } catch (RuntimeException e) {
      defer(e);
      return;
    }
    Pending pending = waiting.remove(row.sequence);
    if (pending != null)
      for (CompletableFuture<Receipt> result : pending.receipts) {
        if (error == null) result.complete(receipt);
        else result.completeExceptionally(error);
      }
    if (error != null) {
      failBarriers(error);
      report(error);
    }
    retryAt = serverRetryAt = 0;
    backoff = 1000;
    pump();
  }

  private void failBarriers(Throwable error) {
    for (Barrier b : barriers) b.result.completeExceptionally(error);
    barriers.clear();
  }

  private void failWaiters(Throwable error) {
    for (Pending pending : waiting.values())
      for (CompletableFuture<Receipt> f : pending.receipts) f.completeExceptionally(error);
    waiting.clear();
    failBarriers(error);
  }

  private void defer(Exception error) {
    failWaiters(error);
    report(error);
    retryAt = SystemClock.elapsedRealtime() + backoff;
    backoff = Math.min(60000, backoff * 2);
    cancelTimer();
    schedule(Math.max(retryAt, serverRetryAt) - SystemClock.elapsedRealtime());
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
          failWaiters(new IllegalStateException("Birdwatch client is closed"));
          io.shutdown();
          if (outbox != null) outbox.close();
          state.shutdown();
        });
  }
}

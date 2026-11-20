package dev.birdwatch.sdk;

import static org.junit.Assert.*;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, manifest = Config.NONE)
public final class ConformanceTest {
  @Test
  public void invalidEventReachesFutureAndErrorHandler() throws Exception {
    LinkedBlockingQueue<Throwable> errors = new LinkedBlockingQueue<>();
    try (Birdwatch client =
        new Birdwatch.Builder(RuntimeEnvironment.getApplication(), "http://127.0.0.1", "test")
            .onError(errors::add)
            .build()) {
      Map<String, Object> cyclic = new HashMap<>();
      cyclic.put("self", cyclic);
      CompletableFuture<?>[] invalid = {
        client.capture(""),
        client.enqueue(new Event("test", cyclic)),
        client.screen(null),
        client.identify(""),
        client.enqueue((Event) null)
      };
      for (CompletableFuture<?> future : invalid) {
        ExecutionException failure =
            assertThrows(ExecutionException.class, () -> future.get(5, TimeUnit.SECONDS));
        assertSame(failure.getCause(), errors.poll(5, TimeUnit.SECONDS));
      }
    }
  }
}

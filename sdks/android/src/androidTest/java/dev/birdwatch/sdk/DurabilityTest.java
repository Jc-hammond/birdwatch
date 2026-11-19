package dev.birdwatch.sdk;

import static org.junit.Assert.*;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class DurabilityTest {
  @Test
  public void restoresSnapshotAndPreservesExistingRowAtCapacity() throws Exception {
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    String scope = UUID.randomUUID().toString();
    Map<String, Object> props = new HashMap<>();
    props.put("total", 29);
    Event purchase = new Event("purchase", props, "order", 1704067200000L);
    props.put("total", 100);
    try (Outbox store = new Outbox(context, scope, "example", 1)) {
      store.identify("original");
      store.put(purchase);
      store.identify("new identity");
      store.put(new Event("changed", null, "order"));
      try {
        store.put(new Event("other", null, "different"));
        fail("Full queue should reject the new occurrence");
      } catch (IllegalStateException expected) {
        assertTrue(expected.getMessage().contains("full"));
      }
    }
    try (Outbox restored = new Outbox(context, scope, "example", 1);
        Outbox other = new Outbox(context, scope + "-other", "other", 1)) {
      assertNull(other.first());
      assertEquals("new identity", restored.identity());
      Outbox.Row entry = restored.first();
      JSONObject body = new JSONObject(entry.body);
      assertEquals("original", body.getString("distinct_id"));
      assertEquals("purchase", body.getString("event"));
      assertEquals("2024-01-01T00:00:00.000Z", body.getString("timestamp"));
      assertEquals(29, body.getJSONObject("properties").getInt("total"));
      restored.remove(entry);
      assertNull(restored.first());
    }
  }

  @Test
  public void refusesInvalidPropertiesBeforeTheyCanOccupyTheQueue() {
    Map<String, Object> cyclic = new HashMap<>();
    cyclic.put("loop", cyclic);
    try {
      new Event("x", cyclic);
      fail();
    } catch (IllegalArgumentException expected) {
      assertTrue(expected.getMessage().contains("Cyclic"));
    }
    cyclic.put("loop", Double.NaN);
    try {
      new Event("x", cyclic);
      fail();
    } catch (IllegalArgumentException expected) {
      assertTrue(expected.getMessage().contains("finite"));
    }
  }
}

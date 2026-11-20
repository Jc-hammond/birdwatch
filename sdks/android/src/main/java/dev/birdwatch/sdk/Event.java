package dev.birdwatch.sdk;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import java.lang.reflect.Array;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** An immutable occurrence. Its ID and timestamp are fixed before any asynchronous work. */
public final class Event {
  final String name;
  final String id;
  final long timestampMillis;
  final String properties;
  final RuntimeException invalid;

  public Event(@NonNull String name, @Nullable Map<String, ?> properties) {
    this(name, properties, UUID.randomUUID().toString(), System.currentTimeMillis());
  }

  public Event(@NonNull String name, @Nullable Map<String, ?> properties, @NonNull String id) {
    this(name, properties, id, System.currentTimeMillis());
  }

  public Event(
      @NonNull String name,
      @Nullable Map<String, ?> properties,
      @NonNull String id,
      long timestampMillis) {
    this.name = name;
    this.id = id == null ? "" : id;
    this.timestampMillis = timestampMillis;
    String snapshot = "{}";
    RuntimeException failure = null;
    try {
      field(name, "event", 128);
      field(id, "id", 128);
      if (timestampMillis < -62135596800000L || timestampMillis > 253402300799999L)
        throw new IllegalArgumentException("Occurrence time is outside the supported range");
      snapshot =
          json(properties == null ? Collections.emptyMap() : properties, new IdentityHashMap<>())
              .toString();
      int length = 0;
      for (int i = 0; i < snapshot.length(); i++) {
        length += snapshot.charAt(i) >= 127 ? 6 : 1;
        if (length > 32768) throw new IllegalArgumentException("Event properties exceed 32 KiB");
      }
    } catch (JSONException e) {
      failure = new IllegalArgumentException("Invalid event properties", e);
    } catch (RuntimeException e) {
      failure = e;
    }
    this.properties = snapshot;
    this.invalid = failure;
  }

  @NonNull
  public String getId() {
    return id;
  }

  public long getTimestampMillis() {
    return timestampMillis;
  }

  static String field(String value, String name, int limit) {
    if (value == null
        || value.trim().isEmpty()
        || value.indexOf(0) >= 0
        || value.codePointCount(0, value.length()) > limit)
      throw new IllegalArgumentException("Invalid " + name);
    return unicode(value);
  }

  private static String unicode(String value) {
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      if (!Character.isSurrogate(c)) continue;
      if (!Character.isHighSurrogate(c)
          || ++i >= value.length()
          || !Character.isLowSurrogate(value.charAt(i)))
        throw new IllegalArgumentException("Unpaired Unicode surrogate");
    }
    return value;
  }

  private static Object json(Object value, IdentityHashMap<Object, Boolean> parents)
      throws JSONException {
    if (value == null) return JSONObject.NULL;
    if (value instanceof String) return unicode((String) value);
    if (value instanceof Boolean) return value;
    if (value instanceof Number) {
      if (!Double.isFinite(((Number) value).doubleValue()))
        throw new IllegalArgumentException("Non-finite number");
      if (value instanceof Byte
          || value instanceof Short
          || value instanceof Integer
          || value instanceof Long
          || value instanceof Float
          || value instanceof Double
          || value instanceof java.math.BigInteger
          || value instanceof java.math.BigDecimal) return value;
      throw new IllegalArgumentException("Unsupported numeric type");
    }
    if (parents.size() >= 64 || parents.put(value, true) != null)
      throw new IllegalArgumentException("Cyclic or deeply nested properties");
    try {
      if (value instanceof Map) {
        JSONObject result = new JSONObject();
        for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
          if (!(entry.getKey() instanceof String))
            throw new IllegalArgumentException("Property keys must be strings");
          result.put(unicode((String) entry.getKey()), json(entry.getValue(), parents));
        }
        return result;
      }
      JSONArray array = new JSONArray();
      if (value instanceof List) {
        for (Object item : (List<?>) value) array.put(json(item, parents));
      } else if (value.getClass().isArray()) {
        for (int i = 0; i < Array.getLength(value); i++)
          array.put(json(Array.get(value, i), parents));
      } else
        throw new IllegalArgumentException(
            "Unsupported event property type: " + value.getClass().getName());
      return array;
    } finally {
      parents.remove(value);
    }
  }
}

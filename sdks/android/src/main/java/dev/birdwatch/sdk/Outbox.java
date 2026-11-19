package dev.birdwatch.sdk;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import java.io.File;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Confined to the storage executor. A transaction orders identity reads, capacity checks and
 * inserts.
 */
final class Outbox extends SQLiteOpenHelper {
  static final class Row {
    final long sequence;
    final String id, body;

    Row(long sequence, String id, String body) {
      this.sequence = sequence;
      this.id = id;
      this.body = body;
    }
  }

  private final String scope, writeKey;
  private final int capacity;
  private final SimpleDateFormat clock =
      new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);

  Outbox(Context context, String scope, String writeKey, int capacity) {
    super(
        context,
        new File(context.getNoBackupFilesDir(), "birdwatch-v1.sqlite3").getAbsolutePath(),
        null,
        1);
    this.scope = scope;
    this.writeKey = writeKey;
    this.capacity = capacity;
    clock.setTimeZone(TimeZone.getTimeZone("UTC"));
  }

  @Override
  public void onCreate(SQLiteDatabase db) {
    db.execSQL("CREATE TABLE identities (scope TEXT PRIMARY KEY NOT NULL, person TEXT NOT NULL)");
    db.execSQL(
        "CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, uuid TEXT"
            + " NOT NULL, body TEXT NOT NULL, UNIQUE(scope,uuid))");
    db.execSQL("CREATE INDEX event_order ON events(scope,seq)");
  }

  @Override
  public void onUpgrade(SQLiteDatabase db, int from, int to) {
    throw new IllegalStateException(
        "Unsupported Birdwatch database migration " + from + " to " + to);
  }

  void identify(String person) {
    getWritableDatabase()
        .execSQL(
            "INSERT OR REPLACE INTO identities(scope,person) VALUES(?,?)",
            new Object[] {scope, person});
  }

  String identity() {
    SQLiteDatabase db = getWritableDatabase();
    db.execSQL(
        "INSERT OR IGNORE INTO identities(scope,person) VALUES(?,?)",
        new Object[] {scope, UUID.randomUUID().toString()});
    return DatabaseUtils.stringForQuery(
        db, "SELECT person FROM identities WHERE scope=?", new String[] {scope});
  }

  Row put(Event event) {
    SQLiteDatabase db = getWritableDatabase();
    db.beginTransaction();
    try {
      Row existing =
          row(
              "SELECT seq,uuid,body FROM events WHERE scope=? AND uuid=?",
              new String[] {scope, event.id});
      if (existing != null) {
        db.setTransactionSuccessful();
        return existing;
      }
      if (DatabaseUtils.longForQuery(
              db, "SELECT COUNT(*) FROM events WHERE scope=?", new String[] {scope})
          >= capacity) throw new IllegalStateException("Birdwatch outbox is full");
      // Retain the original properties JSON, including the precision of integer literals.
      String base =
          new JSONObject()
              .put("api_key", writeKey)
              .put("uuid", event.id)
              .put("event", event.name)
              .put("distinct_id", identity())
              .put("timestamp", clock.format(new Date(event.timestampMillis)))
              .toString();
      String body =
          base.substring(0, base.length() - 1) + ",\"properties\":" + event.properties + "}";
      ContentValues values = new ContentValues();
      values.put("scope", scope);
      values.put("uuid", event.id);
      values.put("body", body);
      Row result = new Row(db.insertOrThrow("events", null, values), event.id, body);
      db.setTransactionSuccessful();
      return result;
    } catch (JSONException e) {
      throw new IllegalArgumentException("Invalid capture", e);
    } finally {
      db.endTransaction();
    }
  }

  Row first() {
    return row(
        "SELECT seq,uuid,body FROM events WHERE scope=? ORDER BY seq LIMIT 1",
        new String[] {scope});
  }

  long lastSequence() {
    return DatabaseUtils.longForQuery(
        getReadableDatabase(),
        "SELECT COALESCE(MAX(seq),0) FROM events WHERE scope=?",
        new String[] {scope});
  }

  void remove(Row row) {
    getWritableDatabase()
        .delete("events", "scope=? AND seq=?", new String[] {scope, Long.toString(row.sequence)});
  }

  private Row row(String sql, String[] args) {
    try (Cursor result = getReadableDatabase().rawQuery(sql, args)) {
      return result.moveToFirst()
          ? new Row(result.getLong(0), result.getString(1), result.getString(2))
          : null;
    }
  }
}

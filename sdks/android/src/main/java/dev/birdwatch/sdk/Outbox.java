package dev.birdwatch.sdk;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import java.io.File;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;
import java.util.function.Consumer;
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

  private final String scope;
  private final Consumer<Throwable> onError;
  private final Consumer<Long> onEvicted;
  private boolean overflow;
  private final int capacity;
  private final SimpleDateFormat clock =
      new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);

  Outbox(
      Context context,
      String scope,
      int capacity,
      Consumer<Throwable> onError,
      Consumer<Throwable> onCorrupt,
      Consumer<Long> onEvicted) {
    super(
        context,
        new File(context.getNoBackupFilesDir(), "birdwatch-v1.sqlite3").getAbsolutePath(),
        null,
        1,
        db -> quarantine(db, onCorrupt));
    this.scope = scope;
    this.capacity = capacity;
    this.onError = onError;
    this.onEvicted = onEvicted;
    clock.setTimeZone(TimeZone.getTimeZone("UTC"));
  }

  private static void quarantine(SQLiteDatabase db, Consumer<Throwable> onError) {
    File source = new File(db.getPath());
    String target = source.getPath() + ".corrupt-" + UUID.randomUUID();
    if (db.isOpen()) db.close();
    // Move journals first. If a move fails, retain the main file and restore the group.
    ArrayList<String> moved = new ArrayList<>();
    for (String suffix : new String[] {"-wal", "-shm", "-journal", ""}) {
      File part = new File(source.getPath() + suffix);
      if (!part.exists()) continue;
      if (!part.renameTo(new File(target + suffix))) {
        for (String previous : moved)
          if (!new File(target + previous).renameTo(new File(source.getPath() + previous)))
            throw new IllegalStateException("Could not restore quarantined outbox files");
        throw new IllegalStateException("Could not quarantine the damaged outbox");
      }
      moved.add(suffix);
    }
    onError.accept(new IllegalStateException("Quarantined a damaged Birdwatch outbox"));
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
    if (event == null) throw new IllegalArgumentException("Event is required");
    if (event.invalid != null) throw event.invalid;
    SQLiteDatabase db = getWritableDatabase();
    long evicted = 0;
    Row result;
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
      // A lower capacity on reopen may expire more than one row.
      try (Cursor cutoff =
          db.rawQuery(
              "SELECT seq FROM events WHERE scope=? ORDER BY seq DESC LIMIT 1 OFFSET ?",
              new String[] {scope, Integer.toString(capacity - 1)})) {
        if (cutoff.moveToFirst()) {
          evicted = cutoff.getLong(0);
          db.delete("events", "scope=? AND seq<=?", new String[] {scope, Long.toString(evicted)});
        }
      }
      // Retain the original properties JSON, including the precision of integer literals.
      String base =
          new JSONObject()
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
      result = new Row(db.insertOrThrow("events", null, values), event.id, body);
      db.setTransactionSuccessful();
    } catch (JSONException e) {
      throw new IllegalArgumentException("Invalid capture", e);
    } finally {
      db.endTransaction();
    }
    if (evicted != 0) {
      onEvicted.accept(evicted);
      if (!overflow)
        onError.accept(new IllegalStateException("Outbox full; dropped the oldest event"));
      overflow = true;
    }
    return result;
  }

  List<Row> batch() {
    ArrayList<Row> rows = new ArrayList<>();
    try (Cursor c =
        getReadableDatabase()
            .rawQuery(
                "SELECT seq,uuid,body FROM events WHERE scope=? ORDER BY seq LIMIT 100",
                new String[] {scope})) {
      while (c.moveToNext()) rows.add(new Row(c.getLong(0), c.getString(1), c.getString(2)));
    }
    return rows;
  }

  long lastSequence() {
    return DatabaseUtils.longForQuery(
        getReadableDatabase(),
        "SELECT COALESCE(MAX(seq),0) FROM events WHERE scope=?",
        new String[] {scope});
  }

  void acknowledge(List<Row> rows) {
    SQLiteDatabase db = getWritableDatabase();
    db.beginTransaction();
    try {
      for (Row row : rows)
        db.delete(
            "events",
            "scope=? AND seq=? AND uuid=?",
            new String[] {scope, Long.toString(row.sequence), row.id});
      db.setTransactionSuccessful();
    } finally {
      db.endTransaction();
    }
    overflow = false;
  }

  private Row row(String sql, String[] args) {
    try (Cursor result = getReadableDatabase().rawQuery(sql, args)) {
      return result.moveToFirst()
          ? new Row(result.getLong(0), result.getString(1), result.getString(2))
          : null;
    }
  }
}

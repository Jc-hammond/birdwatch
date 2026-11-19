"""Validate a capture request before writing its events in one transaction."""
import json
from datetime import timedelta
from .database import parse_time, stamp, utcnow


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def string(value, field, limit=256):
    if not isinstance(value, str) or not value.strip() or len(value) > limit or "\x00" in value:
        raise ApiError(400, f"{field} must be a nonempty string of at most {limit} characters")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        raise ApiError(400, f"{field} must contain valid Unicode")
    return value


def capture(db, body):
    key = string(body.get("api_key"), "api_key", 128)
    project = db.execute("SELECT id FROM projects WHERE write_key=?", (key,)).fetchone()
    if not project:
        raise ApiError(401, "Unknown project write key")
    batch = body.get("batch", [body])
    if not isinstance(batch, list) or not 1 <= len(batch) <= 100:
        raise ApiError(400, "A batch must contain 1–100 events")
    now = utcnow()
    rows = []
    for item in batch:
        if not isinstance(item, dict):
            raise ApiError(400, "Each event must be an object")
        name = string(item.get("event"), "event", 128)
        person = string(item.get("distinct_id"), "distinct_id")
        props = item.get("properties", {})
        if not isinstance(props, dict):
            raise ApiError(400, "properties must be an object")
        try:
            encoded = json.dumps(props, separators=(",",":"), allow_nan=False)
        except (ValueError, RecursionError):
            raise ApiError(400, "Invalid event properties")
        if len(encoded) > 32768:
            raise ApiError(400, "Event properties exceed 32 KiB")
        ts = now
        if "timestamp" in item:
            try:
                ts = parse_time(string(item["timestamp"], "timestamp", 64))
            except (ValueError, OverflowError):
                raise ApiError(400, "Use an ISO 8601 timestamp with a time zone")
            if ts > now + timedelta(minutes=5):
                raise ApiError(400, "Timestamp is too far in the future")
        uid = string(item["uuid"], "uuid", 128) if "uuid" in item else None
        rows.append((project[0], name, person, stamp(ts), encoded, uid))
    changed = db.total_changes
    db.executemany("""INSERT INTO events(project_id,event,distinct_id,timestamp,properties,uuid)
                      VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,uuid) DO NOTHING""", rows)
    added = db.total_changes-changed
    return {"accepted":added, "duplicates":len(rows)-added}

# Capture protocol

This page is the single definition of how events reach a Birdwatch server. The server and every SDK implement it. To change behaviour, change this page, the contract tests and the code in one pull request.

The words **must** and **must not** are requirements. Sizes are in bytes of the UTF-8 body. Lengths are in Unicode characters.

## Request

```http
POST /api/capture
Content-Type: application/json
```

The capture endpoint accepts cross-origin requests using the project write key. Clients can send events without the dashboard’s HTTP Basic credentials.

The body is a JSON object: a batch, or a single event.

**Batch.** This is what SDKs send.

```json
{
  "api_key": "bw_live_3f9c",
  "sent_at": "2026-11-19T12:00:00.000Z",
  "batch": [
    {
      "event": "signup",
      "distinct_id": "user-42",
      "properties": { "plan": "free" },
      "timestamp": "2026-11-19T11:59:30.000Z",
      "uuid": "0193f2a4-7c1e-7b3a-9d2e-5a1c8e4f6b70"
    }
  ]
}
```

| Field | Required | Rule |
| --- | --- | --- |
| `api_key` | yes | The project's write key, 1–128 characters |
| `batch` | yes | An array of 1–100 events |
| `sent_at` | no | The client's clock when this attempt was sent. Same format as `timestamp`. A value that cannot be parsed is treated as absent |
| `atomic` | no | `true` stores all events or none. Defaults to `false` |

**Single event.** The event's fields sit beside `api_key`. It is handled as an atomic batch of one, so an invalid event returns an error status. It is meant for `curl` and quick tests.

```json
{ "api_key": "bw_live_3f9c", "event": "signup", "distinct_id": "user-42" }
```

**Event fields**

| Field | Required | Rule |
| --- | --- | --- |
| `event` | yes | String, 1–128 characters |
| `distinct_id` | yes | String, 1–256 characters |
| `properties` | no | A JSON object. At most 32 KiB (32,768 bytes) when encoded as compact JSON |
| `timestamp` | no | ISO 8601 with a time zone, at most 64 characters. Defaults to the time of receipt |
| `uuid` | no | String, 1–128 characters. SDKs must always send one |

Strings must not be blank and must not contain a NUL character. Unknown fields are ignored.

**Limits.** A request holds at most 100 events and 1 MiB (1,048,576 bytes).

**Content type.** The server parses the body as JSON whatever the `Content-Type` says. Browsers send `text/plain` so that the request needs no preflight and works with `sendBeacon`.

## Response

A request that the server could process returns `200` and a result for every event.

```json
{
  "accepted": 2,
  "duplicates": 1,
  "rejected": [
    { "index": 3, "code": "invalid_event", "message": "distinct_id must be a string of 1–256 characters" }
  ]
}
```

- `accepted` counts events stored by this request.
- `duplicates` counts events whose `uuid` was already stored. See [Duplicates](#duplicates).
- `rejected` lists the events that were not stored. `index` is the event's position in `batch`, starting at 0. `code` is `invalid_event` or `too_large`.
- The three always add up to the number of events sent.
- Valid events are stored even when others in the batch are rejected. A batch in which every event is rejected still returns `200`.

**Atomic.** With `"atomic": true`, one rejected event means nothing is stored. The response is `400` with the usual error body plus the `rejected` list.

```json
{
  "error": "1 of 4 events was rejected, so none were stored",
  "code": "invalid_event",
  "rejected": [
    { "index": 3, "code": "invalid_event", "message": "distinct_id must be a string of 1–256 characters" }
  ]
}
```

## Errors

A request that fails as a whole returns an error status and this body. The message says what to change.

```json
{ "error": "Unknown project write key. Copy the key from the project's Setup page.", "code": "unknown_key" }
```

| Code | Status | Meaning |
| --- | --- | --- |
| `invalid_event` | 400 | The body is not valid JSON, is not an object, has no `api_key`, or has an empty or malformed `batch`. Also used per event |
| `unknown_key` | 401 | No project has this write key |
| `too_large` | 413 | The body is over 1 MiB or the batch has more than 100 events. Also used per event when `properties` is over 32 KiB |
| `rate_limited` | 429 | Too many requests. Sent with `Retry-After` |
| `unavailable` | 503 | The server is busy or shutting down. Sent with `Retry-After` |
| `internal` | 500 | A fault in the server |

`Retry-After` is a whole number of seconds.

```http
HTTP/1.1 503 Service Unavailable
Retry-After: 30
Content-Type: application/json

{ "error": "The server is busy. Try again in 30 seconds.", "code": "unavailable" }
```

## What a client does with each outcome

A response is **recognised** when its body is a JSON object that has `accepted` (status 200) or `code` (any other status). Anything else is unrecognised, whatever its status. An HTML error page from a proxy is the usual case.

| Outcome | Action |
| --- | --- |
| `200` with results | Remove every event in the batch from the queue. Report each rejected event to `onError` once |
| `invalid_event` or `too_large` for the whole request | Remove the batch and report it to `onError`. Sending it again cannot succeed |
| `unknown_key` | Stop sending and keep the queue. Report to `onError` once. Resume when the app restarts or the key changes |
| Network error, timeout, `408`, `429`, any `5xx` | Keep the batch and retry |
| Unrecognised response, or a code not in the table above | Keep the batch and retry |

**Retrying.** Wait before each retry, then send the same events again.

- The delay ceiling starts at 1 second and doubles after each failed attempt, up to 60 seconds: 1, 2, 4, 8, 16, 32, 60, 60, …
- The actual delay is a random time between 0 and the ceiling (full jitter).
- If the response has `Retry-After`, wait that long, up to 5 minutes, and ignore the computed delay for that attempt.
- A successful attempt resets the ceiling to 1 second.
- One failed attempt advances the ceiling once, however many events it carried.

For example, after a third failure in a row the client waits a random time between 0 and 4 seconds. After a `503` with `Retry-After: 30` it waits 30 seconds. After `Retry-After: 900` it waits 300 seconds.

## Clocks

The server never rejects an event because its time is in the future. It corrects the time.

- **With `sent_at`:** the server adds `received_at − sent_at` to every event `timestamp` in the batch. `received_at` is the server's clock when the request arrived.
- **Without `sent_at`:** timestamps are used as given.
- **In both cases:** a time that is still later than `received_at` is stored as `received_at`.
- An event with no `timestamp` is stored at `received_at`.
- Times in the past are accepted, however old.
- Times are stored in UTC.

For example, a phone's clock runs 10 minutes fast. It sends a batch with `sent_at` of `12:10:00Z` holding an event stamped `12:09:30Z`. The server receives it at `12:00:00Z`, so the offset is −10 minutes and the event is stored at `11:59:30Z`.

A client must set `sent_at` from the same clock as its event timestamps, at the moment of each attempt.

## Duplicates

`uuid` is unique within a project. An event whose `uuid` is already stored is not stored again. It is counted in `duplicates`, and that is a success, not an error. The first copy wins; the content of a repeat is ignored. The same holds for two events with one `uuid` inside a single batch.

This is what makes retries safe. If the acknowledgement of a batch is lost, the client sends it again and gets:

```json
{ "accepted": 0, "duplicates": 3, "rejected": [] }
```

A client must give each event its `uuid` and `timestamp` when the event is captured and must not change the event when sending it again. Only `sent_at` changes between attempts.

Events without a `uuid` are never treated as duplicates.

## Browsers

Every capture response, including errors, carries:

```http
Access-Control-Allow-Origin: *
```

A preflight request is answered with `204` and:

```http
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
Access-Control-Max-Age: 86400
```

Capture never reads or sets cookies and never allows credentials.

## Project retention and erasure

The owner can set a project's raw event lifetime with `PATCH /api/projects/{id}`.
Send `{"retention_days":30}` for a whole number of days, or
`{"retention_days":null}` to keep raw events indefinitely (the default). A
successful response echoes the setting. Setup and project listings also return it.
At startup and once an hour, the server removes expired raw events in transactions
of at most 10,000. It keeps daily counts, including each person's contribution
by event name, so totals survive a sweep and can still be corrected on erasure.

`DELETE /api/projects/{id}/people/{distinct_id}` erases the person's raw events
and daily contributions within that project. Encode the ID as one URL path
segment. The response `{"removed":2}` counts events removed from the project's
totals, including previously expired contributions. Repeating the request returns
zero. Both operations use dashboard owner access and reject changes to the sample
project with HTTP 403.

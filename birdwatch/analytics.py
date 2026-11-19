"""Read models for the dashboard. All report boundaries use UTC."""
import json
from datetime import timedelta
from .database import parse_time, stamp, utcnow


def clock_for(project):
    return parse_time(project["sample_as_of"]) if project["sample_as_of"] else utcnow()


def bounds(project, days):
    now = clock_for(project)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=days-1)
    return start, now


def metrics(row):
    count, people, pages = map(int, row)
    return [count, people, pages, round(count/people, 1) if people else 0]


TOTALS = """COUNT(*), COUNT(DISTINCT distinct_id),
            COALESCE(SUM(CASE WHEN event IN ('page_view','$pageview') THEN 1 ELSE 0 END),0)"""


def overview(db, project, days):
    start, now = bounds(project, days)
    pid = project["id"]
    def totals(a, b):
        return metrics(db.execute(f"SELECT {TOTALS} FROM events WHERE project_id=? AND timestamp>=? AND timestamp<=?",
                                  (pid, stamp(a), stamp(b))).fetchone())
    # Compare like-for-like elapsed intervals, including today's partial day.
    period = timedelta(days=days)
    current, previous = totals(start, now), totals(start-period, now-period)
    records = db.execute(f"""SELECT substr(timestamp,1,10), {TOTALS} FROM events
                             WHERE project_id=? AND timestamp BETWEEN ? AND ? GROUP BY 1""",
                         (pid, stamp(start), stamp(now)))
    by_day = {r[0]: metrics(r[1:]) for r in records}
    series = []
    for i in range(days):
        date = (start+timedelta(days=i)).date().isoformat()
        series.append({"date": date, "values": by_day.get(date, [0,0,0,0])})
    top = db.execute("""SELECT event,COUNT(*) AS n FROM events WHERE project_id=? AND
                        timestamp BETWEEN ? AND ? GROUP BY event ORDER BY n DESC,event LIMIT 5""",
                     (pid, stamp(start), stamp(now)))
    recent = events(db, project, days, limit=5)
    return {"current":current, "previous":previous, "series":series,
            "top":[dict(r) for r in top], "recent":recent["rows"], "as_of":stamp(now)}


def like(value):
    return "%" + value.replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%"


def events(db, project, days, search="", person="", name="", offset=0, limit=30):
    start, now = bounds(project, days)
    where = "project_id=? AND timestamp BETWEEN ? AND ?"
    params = [project["id"], stamp(start), stamp(now)]
    if search:
        where += " AND (event LIKE ? ESCAPE '!' OR distinct_id LIKE ? ESCAPE '!')"
        params += [like(search)]*2
    if person:
        where += " AND distinct_id=?"
        params.append(person)
    if name:
        where += " AND event=?"
        params.append(name)
    rows = db.execute(f"""SELECT id,event,distinct_id,timestamp,properties FROM events WHERE {where}
                          ORDER BY timestamp DESC,id DESC LIMIT ? OFFSET ?""", params+[limit+1,offset]).fetchall()
    return {"rows":[dict(r, properties=json.loads(r["properties"])) for r in rows[:limit]],
            "more":len(rows)>limit, "as_of":stamp(now)}


def people(db, project, days, search="", offset=0, limit=30):
    start, now = bounds(project, days)
    rows = db.execute("""SELECT distinct_id,COUNT(*) AS n,MIN(timestamp) AS first_seen,MAX(timestamp) AS last_seen
                         FROM events WHERE project_id=? AND timestamp BETWEEN ? AND ? AND distinct_id LIKE ? ESCAPE '!'
                         GROUP BY distinct_id ORDER BY last_seen DESC,distinct_id LIMIT ? OFFSET ?""",
                      (project["id"],stamp(start),stamp(now),like(search),limit+1,offset)).fetchall()
    return {"rows":[dict(r) for r in rows[:limit]], "more":len(rows)>limit}


def event_names(db, project):
    return [r[0] for r in db.execute("SELECT DISTINCT event FROM events WHERE project_id=? ORDER BY event",
                                      (project["id"],))]


def funnel(db, project, days, first, second):
    start, now = bounds(project, days)
    # Each person's earliest qualifying first step maximizes their conversion window.
    # Ties use insertion order, so one event can never count as both steps.
    rows = db.execute("""WITH starts AS (
                           SELECT distinct_id,timestamp,id,ROW_NUMBER() OVER
                             (PARTITION BY distinct_id ORDER BY timestamp,id) AS rank
                           FROM events WHERE project_id=? AND event=? AND timestamp BETWEEN ? AND ?
                         )
                         SELECT COUNT(*), COALESCE(SUM(EXISTS(
                           SELECT 1 FROM events e WHERE e.project_id=? AND e.distinct_id=s.distinct_id AND e.event=?
                             AND (e.timestamp,e.id)>(s.timestamp,s.id) AND e.timestamp<=?
                         )),0) FROM starts s WHERE rank=1""",
                      (project["id"],first,stamp(start),stamp(now),project["id"],second,stamp(now))).fetchone()
    return {"entered":rows[0], "converted":rows[1]}

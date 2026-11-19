import base64
import http.client
import json
import tempfile
import threading
import unittest
from datetime import timedelta
from http.server import ThreadingHTTPServer
from pathlib import Path

from server import Handler
from birdwatch import analytics
from birdwatch.database import connection, initialize, new_project, stamp, utcnow


class QuietHandler(Handler):
    def log_message(self, *args):
        pass


class AnalyticsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = str(Path(self.tmp.name)/"events.sqlite3")
        initialize(self.path, demo=False)
        with connection(self.path) as db:
            self.project = db.execute("SELECT * FROM projects").fetchone()
            self.other = new_project(db, "Second")
        self.server = ThreadingHTTPServer(("127.0.0.1",0), QuietHandler)
        self.server.database, self.server.password = self.path, ""
        thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval":0.02}, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def request(self, method, route, body=None, headers=None):
        client = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            h = {"Content-Type":"application/json", **(headers or {})}
            client.request(method,route,json.dumps(body) if body is not None else None,h)
            response = client.getresponse()
            data = response.read()
            return response.status, json.loads(data) if data else None, dict(response.getheaders())
        finally:
            client.close()

    def capture(self, **fields):
        return self.request("POST","/api/capture",{"api_key":self.project["write_key"],
                            "event":"page_view","distinct_id":"alice",**fields})

    def report(self, kind):
        return self.request("GET", f"/api/projects/{self.project['id']}/{kind}")[1]

    def test_ingestion_persistence_and_reports(self):
        self.assertEqual(self.capture(properties={"screen":"welcome"},uuid="once")[1]["accepted"],1)
        self.assertEqual(self.capture(uuid="once")[1]["duplicates"],1)
        self.capture(event="sign_up")
        self.capture(distinct_id="bob",event="$pageview")
        initialize(self.path, demo=False)
        report = self.report("overview?days=7")
        self.assertEqual(report["current"],[3,2,2,1.5])
        self.assertEqual(sum(d["values"][0] for d in report["series"]),3)
        self.assertEqual(self.report("events?person=alice")["rows"][1]["properties"]["screen"],"welcome")
        self.assertEqual(len(self.report("people")["rows"]),2)
        self.assertEqual(self.request("GET",f"/api/projects/{self.other}/overview")[1]["current"],[0,0,0,0])

    def test_batch_rollback(self):
        self.assertEqual(self.capture(batch=[{"event":"first","distinct_id":"a"},{"event":""}])[0],400)
        self.assertEqual(self.report("overview")["current"][0],0)
        self.assertEqual(self.capture(batch=[{"event":"first","distinct_id":"a"},{"event":"last","distinct_id":"a"}])[1]["accepted"],2)

    def test_same_time_order_and_repeat_steps(self):
        now = stamp(utcnow()-timedelta(seconds=1))
        for user, name in [("yes","a"),("yes","b"),("no","b"),("no","a"),("twice","a"),("twice","a")]:
            self.capture(event=name,distinct_id=user,timestamp=now)
        self.assertEqual(self.report("funnel?first=a&second=b"),{"entered":3,"converted":1})
        self.assertEqual(self.report("funnel?first=a&second=a"),{"entered":3,"converted":1})

    def test_utc_window(self):
        ts = utcnow().replace(hour=0,minute=0,second=0,microsecond=0)
        self.capture(event="old",timestamp=stamp(ts-timedelta(microseconds=1)))
        self.capture(event="today",timestamp=stamp(ts))
        self.assertEqual(self.report("overview?days=1")["current"],[1,1,0,1])
        self.assertEqual(self.report("overview?days=7")["current"][0],2)
        self.assertEqual(self.report("funnel?days=1&first=old&second=today")["entered"],0)

    def test_input_and_project_boundaries(self):
        self.assertEqual(self.capture(api_key="unknown")[0],401)
        for fields in [dict(event=" "),dict(properties=[]),dict(timestamp="not-a-date"),
                       dict(timestamp="2025-02-01"),dict(distinct_id=None),dict(uuid="")]:
            self.assertEqual(self.capture(**fields)[0],400)
        self.assertEqual(self.request("POST","/api/projects",{"name":" "})[0],400)
        status, res, _ = self.request("POST","/api/projects",{"name":"Example"})
        self.assertEqual(status,201)
        self.assertTrue(self.request("GET",f"/api/projects/{res['id']}/setup")[1]["write_key"].startswith("bw_"))

    def test_search_and_pagination(self):
        batch = [{"event":"a_b","distinct_id":"%"} for _ in range(32)]
        batch.append({"event":"axb","distinct_id":"outside"})
        self.capture(batch=batch)
        self.assertEqual(len(self.report("events?q=a_b")["rows"]),30)
        self.assertEqual(len(self.report("events?q=a_b&offset=30")["rows"]),2)
        self.assertEqual(len(self.report("people?q=%25")["rows"]),1)

    def test_origin_access_and_auth(self):
        self.assertEqual(self.request("GET","/api/projects",headers={"Host":"foreign.test"})[0],403)
        self.assertEqual(self.request("POST","/api/projects",{"name":"x"},{"Origin":"https://foreign.test"})[0],403)
        self.assertEqual(self.request("OPTIONS","/api/capture",headers={"Origin":"https://app.test"})[2]["Access-Control-Allow-Origin"],"*")
        self.server.password = "sample-test-password"
        self.assertEqual(self.request("GET","/api/projects")[0],401)
        auth = "Basic "+base64.b64encode(b"admin:sample-test-password").decode()
        self.assertEqual(self.request("GET","/api/projects",headers={"Authorization":auth})[0],200)
        self.assertEqual(self.capture()[0],200)
        self.assertEqual(self.request("GET","/api/projects",headers={"Authorization":auth})[2].get("Access-Control-Allow-Origin"),None)

    def test_demo_is_separate_and_frozen(self):
        sample_path = str(Path(self.tmp.name)/"demo.sqlite3")
        initialize(sample_path)
        initialize(sample_path)
        with connection(sample_path) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM projects").fetchone()[0],1)
            project = db.execute("SELECT * FROM projects").fetchone()
            self.assertIsNone(project["write_key"])
            self.assertEqual(stamp(analytics.clock_for(project)),project["sample_as_of"])
            self.assertGreater(analytics.overview(db,project,7)["current"][0],0)


if __name__ == "__main__":
    unittest.main()

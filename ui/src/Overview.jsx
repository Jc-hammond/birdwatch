import React, { useState } from "react";
import { ArrowDown, ArrowRight, ArrowUp, Minus, Zap } from "lucide-react";
import {
  ago,
  DataState,
  day,
  Empty,
  EventIcon,
  int,
  metricIcons,
  short,
  useData,
} from "./lib";

const titles = [
  "Total events",
  "Active users",
  "Page views",
  "Events per user",
];

function Sparkline({ values, index }) {
  if (values.length < 2) return null;
  const low = Math.min(...values),
    high = Math.max(...values);
  const points = values.map((n, i) => [
    (i / (values.length - 1)) * 86,
    29 - ((n - low) / (high - low || 1)) * 23,
  ]);
  const line = points.map((point) => point.join(",")).join(" ");
  const color = index % 2 ? "var(--violet)" : "var(--orange)";
  return (
    <svg className="spark" viewBox="0 0 86 40" aria-hidden="true">
      <defs>
        <linearGradient id={"fade" + index} x2="0" y2="1">
          <stop stopColor={color} stopOpacity=".25" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon
        points={"0,40 " + line + " 86,40"}
        fill={"url(#fade" + index + ")"}
      />
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth="2.2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
function Metrics({ report, days }) {
  return (
    <div className="metrics">
      {titles.map((name, i) => {
        const Icon = metricIcons[i],
          val = report.current[i],
          prev = report.previous[i];
        const change = prev
          ? Math.round((1000 * (val - prev)) / prev) / 10
          : null;
        const Arrow =
          change === null || change === 0
            ? Minus
            : change > 0
            ? ArrowUp
            : ArrowDown;
        return (
          <article className="card metric" key={name}>
            <div className="metric-title">
              <Icon size={18} />
              {name}
            </div>
            <div className="metric-value">
              <strong>{int(val)}</strong>
              <Sparkline
                index={i}
                values={report.series.map((d) => d.values[i])}
              />
            </div>
            <div className="comparison">
              <b
                className={
                  change === null || change === 0
                    ? "steady"
                    : change > 0
                    ? "up"
                    : "down"
                }
              >
                <Arrow size={13} />
                {change === null ? "—" : (change > 0 ? "+" : "") + change + "%"}
              </b>
              <span>vs. previous {days === 1 ? "day" : days + " days"}
                {report.previous_full_day && " · includes all of " + report.previous_full_day + " UTC"}
              </span>
            </div>
          </article>
        );
      })}
    </div>
  );
}
function Chart({ series }) {
  const [show, setShow] = useState([true, true]);
  const max = Math.max(
    1,
    ...series.map((d) =>
      Math.max(show[0] ? d.values[0] : 0, show[1] ? d.values[2] : 0)
    )
  );
  const raw = max / 4,
    unit = 10 ** Math.floor(Math.log10(raw)),
    step = Math.max(1, Math.ceil(raw / unit) * unit);
  const ceiling = step * 4;
  const ticks = [4, 3, 2, 1, 0];
  function toggle(i) {
    setShow((old) =>
      old.map((v, k) => (k === i ? (old[1 - i] ? !v : true) : v))
    );
  }
  return (
    <section className="card chart-card">
      <header className="panel-header">
        <div>
          <h2>Events by day</h2>
        </div>
        <div className="legend">
          {["Events", "Page views"].map((label, i) => (
            <button
              key={label}
              aria-pressed={show[i]}
              onClick={() => toggle(i)}
              className={show[i] ? "" : "muted"}
            >
              <i className={i ? "violet" : "orange"} />
              {label}
            </button>
          ))}
        </div>
      </header>
      <div className={"chart " + (series.length > 14 ? "dense" : "")}>
        <div className="y-axis">
          {ticks.map((n) => (
            <span key={n}>{short(n * step)}</span>
          ))}
        </div>
        <div className="plot">
          <div className="grid-lines">
            {ticks.map((n) => (
              <i key={n} />
            ))}
          </div>
          <div className="groups">
            {series.map((d, i) => (
              <div
                className="group"
                key={d.date}
                tabIndex="0"
                aria-label={
                  day(d.date) +
                  ": " +
                  int(d.values[0]) +
                  (d.values[0] === 1 ? " event, " : " events, ") +
                  int(d.values[2]) +
                  (d.values[2] === 1 ? " page view" : " page views")
                }
              >
                {show[0] && (
                  <i
                    className="bar orange"
                    style={{ height: (d.values[0] / ceiling) * 100 + "%" }}
                  />
                )}
                {show[1] && (
                  <i
                    className="bar violet"
                    style={{ height: (d.values[2] / ceiling) * 100 + "%" }}
                  />
                )}
                <div
                  className={
                    "tooltip " +
                    (i < series.length / 2 ? "from-left" : "from-right")
                  }
                >
                  <strong>{day(d.date)} · UTC</strong>
                  <span>
                    Events <b>{int(d.values[0])}</b>
                  </span>
                  <span>
                    Page views <b>{int(d.values[2])}</b>
                  </span>
                </div>
                <span
                  className={
                    "x-label " +
                    (series.length > 7 && i % Math.ceil(series.length / 7) !== 0
                      ? "skip"
                      : "")
                  }
                >
                  {day(d.date)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
export function Overview({ project, days, go, inspect }) {
  const state = useData(
    "/api/projects/" + project.id + "/overview?days=" + days,
    0,
    project.sample_as_of ? 0 : 5000
  );
  const r = state.data;
  if (!r) return <DataState state={state} />;
  return (
    <>
      {state.error && <DataState state={state} />}
      <Metrics report={r} days={days} />
      <Chart series={r.series} />
      <div className="lower-grid">
        <section className="card list-card">
          <header className="panel-header">
            <h2>Top events</h2>
            <button className="subtle" onClick={() => go("Events")}>
              View events <ArrowRight size={16} />
            </button>
          </header>
          {r.top.length ? (
            r.top.map((row) => (
              <button
                className="top-row"
                key={row.event}
                onClick={() => go("Events", { name: row.event })}
              >
                <EventIcon name={row.event} />
                <span className="event-name">{row.event}</span>
                <span className="track">
                  <i style={{ width: (row.n / r.current[0]) * 100 + "%" }} />
                </span>
                <span className="amount">{int(row.n)}</span>
              </button>
            ))
          ) : (
            <Empty title="No events in this date range">
              Try a different date range or send an event from Setup.
            </Empty>
          )}
        </section>
        <section className="card list-card">
          <header className="panel-header">
            <h2>Recent activity</h2>
            <span className="status">
              <i className={"dot " + (project.sample_as_of ? "sample" : "")} />
              {project.sample_as_of ? "Sample" : "Live"}
            </span>
          </header>
          {r.recent.length ? (
            r.recent.map((row) => (
              <button
                className="recent-row"
                key={row.id}
                onClick={() => inspect(row)}
              >
                <span className="bolt">
                  <Zap size={15} />
                </span>
                <span className="recent-info">
                  <b>{row.event}</b>
                  <small>{row.distinct_id}</small>
                </span>
                <span className="when">{ago(row.timestamp, r.as_of)}</span>
              </button>
            ))
          ) : (
            <Empty title="No recent events">
              New events will appear here as they arrive.
            </Empty>
          )}
        </section>
      </div>
    </>
  );
}

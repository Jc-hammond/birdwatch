import React, { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Search,
  UserRound,
  X,
} from "lucide-react";
import {
  DataState,
  dateTime,
  Empty,
  EventIcon,
  int,
  Select,
  useData,
} from "./lib";

export function Explorer({ view, project, days, filters, go, inspect }) {
  const search = filters.q || "";
  const [query, setQuery] = useState(search);
  const editing = useRef(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search);
      editing.current = false;
    }, 180);
    return () => clearTimeout(timer);
  }, [search]);
  function change(value) {
    const { q, ...other } = filters;
    go(view, value ? { ...other, q: value } : other, editing.current);
    editing.current = true;
  }
  return (
    <section className="card explorer">
      <header className="table-toolbar">
        <label className="search">
          <Search size={16} />
          <input aria-label={"Search " + view.toLowerCase()}
            placeholder={view === "People" ? "Search by user ID…" : "Search by event name or user ID…"}
            value={search} onBlur={() => { editing.current = false; }} onChange={(e) => change(e.target.value)} />
        </label>
        {(filters.name || filters.person) && (
          <button className="chip" title="Remove filter" onClick={() => go(view, search ? { q: search } : {})}>
            {filters.name || filters.person} <X size={14} />
          </button>
        )}
      </header>
      <Results key={query} {...{ view, project, days, go, inspect }} filters={{ ...filters, q: query }} />
    </section>
  );
}
function Results({ view, project, days, filters, go, inspect }) {
  const isPeople = view === "People";
  const [pages, setPages] = useState([]), [pageIndex, setPageIndex] = useState(0);
  const offset = pageIndex * 30;
  const params = new URLSearchParams({ days, ...filters });
  if (pageIndex) params.set("cursor", pages[pageIndex - 1].next);
  else params.set("include_total", "1");
  const cached = pages[pageIndex];
  const live = useData(
    cached ? null :
    "/api/projects/" +
      project.id +
      "/" +
      (isPeople ? "people" : "events") +
      "?" +
      params,
    0,
    project.sample_as_of || offset ? 0 : 5000
  );
  useEffect(() => {
    if (pageIndex && live.code === "cursor_expired") {
      setPages([]);
      setPageIndex(0);
    }
  }, [pageIndex, live.code]);
  const state = cached ? { data: cached } : live;
  const rows = state.data?.rows;
  const first = pages[0] ?? live.data;
  const total = first?.total;
  const unit = (count) => isPeople ? (count === 1 ? "person" : "people") : (count === 1 ? "event" : "events");
  return (
    <>
      {state.error && <DataState state={state} />}
      {!rows && !state.error && <DataState state={state} />}
      {rows?.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {(isPeople
                  ? [
                      "User ID",
                      "Events",
                      "First event",
                      "Last event",
                    ]
                  : ["Event", "User ID", "Event time", ""]
                ).map((name, i) => (
                  <th key={i}>{name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) =>
                isPeople ? (
                  <tr key={row.distinct_id}>
                    <td>
                      <button
                        className="row-link"
                        onClick={() =>
                          go("Events", { person: row.distinct_id })
                        }
                      >
                        <UserRound size={16} />
                        {row.distinct_id}
                      </button>
                    </td>
                    <td>{int(row.n)}</td>
                    <td>{dateTime(row.first_seen)}</td>
                    <td>{dateTime(row.last_seen)}</td>
                  </tr>
                ) : (
                  <tr key={row.id}>
                    <td>
                      <button className="row-link" onClick={() => inspect(row)}>
                        <EventIcon name={row.event} />
                        {row.event}
                      </button>
                    </td>
                    <td>
                      <button
                        className="text-link"
                        onClick={() =>
                          go("Events", { person: row.distinct_id })
                        }
                      >
                        {row.distinct_id}
                      </button>
                    </td>
                    <td>{dateTime(row.timestamp)}</td>
                    <td>
                      <button
                        className="icon-button"
                        aria-label={"View event " + row.id}
                        onClick={() => inspect(row)}
                      >
                        <ChevronRight size={15} />
                      </button>
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        </div>
      )}
      {rows?.length === 0 && (
        <Empty title={isPeople ? "No matching people" : "No matching events"}>
          Try a different date range or clear your search and filters.
        </Empty>
      )}
      {rows && (
        <footer className="pagination">
          <span>
            {rows.length ? int(offset + 1) + "–" + int(offset + rows.length) : "0"}
            {Number.isInteger(total) ? " of " + int(total) + " " + unit(total) : " · count unavailable"}
          </span>
          <div>
            <button
              className="secondary small"
              disabled={!offset}
              onClick={() => setPageIndex(pageIndex - 1)}
            >
              <ChevronLeft size={14} />
              Previous
            </button>
            <button
              className="secondary small"
              disabled={!state.data.next}
              onClick={() => {
                if (!cached) setPages([...pages, state.data]);
                setPageIndex(pageIndex + 1);
              }}
            >
              Next
              <ChevronRight size={14} />
            </button>
          </div>
        </footer>
      )}
    </>
  );
}

export function Funnels({ project, days }) {
  const options = useData(
    "/api/projects/" + project.id + "/names",
    0,
    project.sample_as_of ? 0 : 5000
  );
  const names = options.data?.names || [];
  const [steps, setSteps] = useState(["", ""]);
  const first =
    steps[0] || (names.includes("page_view") ? "page_view" : names[0]);
  const second =
    steps[1] ||
    (names.includes("sign_up")
      ? "sign_up"
      : names.find((n) => n !== first) || first);
  const params = new URLSearchParams({ days, first, second });
  const state = useData(
    first && second
      ? "/api/projects/" + project.id + "/funnel?" + params
      : null,
    0,
    project.sample_as_of ? 0 : 5000
  );
  if (options.error || !options.data) return <DataState state={options} />;
  if (!names.length)
    return (
      <section className="card">
        <Empty title="No events to use in a funnel">
          Send events to this project to start building a funnel.
        </Empty>
      </section>
    );
  if (state.error) return <DataState state={state} />;
  const r = state.data;
  const rate = r?.entered
    ? Math.round((1000 * r.converted) / r.entered) / 10
    : 0;
  return (
    <section className="card funnel">
      <header>
        <h2>Conversion funnel</h2>
        <p>
          Choose the first event and the event that should follow it.
        </p>
      </header>
      <div className="steps">
        {[first, second].map((v, i) => (
          <React.Fragment key={i}>
            {i === 1 && <ArrowRight size={20} />}
            <div>
              <label>Step {i + 1}</label>
              <Select
                label={"Step " + (i + 1) + " event"}
                value={v}
                onChange={(value) =>
                  setSteps(i ? [first, value] : [value, second])
                }
              >
                {names.map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </Select>
            </div>
          </React.Fragment>
        ))}
      </div>
      {r ? (
        <>
          <div className="funnel-summary">
            <strong>{int(rate)}%</strong>
            <span>conversion rate</span>
          </div>
          <div className="funnel-bars">
            {[r.entered, r.converted].map((n, i) => (
              <div key={i}>
                <div>
                  <b>{i ? second : first}</b>
                  <span>
                    {int(n)} {n === 1 ? "person" : "people"}
                  </span>
                </div>
                <div className="funnel-track">
                  <i
                    className={i ? "violet" : "orange"}
                    style={{
                      width: (r.entered ? (n / r.entered) * 100 : 0) + "%",
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <DataState state={state} />
      )}
    </section>
  );
}

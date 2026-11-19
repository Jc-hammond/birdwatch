import React, { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  Box,
  ChartNoAxesColumnIncreasing,
  ChevronDown,
  CornerDownLeft,
  Layers3,
  LoaderCircle,
  MousePointer2,
  PanelTop,
  Play,
  UserRound,
  X,
  Zap,
} from "lucide-react";

export const ranges = [
  [1, "Today"],
  [7, "Last 7 days"],
  [14, "Last 14 days"],
  [30, "Last 30 days"],
];
export const int = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 })
  .format;
export const short = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
}).format;
export const day = (value) =>
  new Date(value.slice(0, 10) + "T12:00:00Z").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
export const dateTime = (value) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
    hour12: false,
  }) + " UTC";
export function ago(time, asOf) {
  const seconds = Math.max(
    0,
    Math.floor((Date.parse(asOf) - Date.parse(time)) / 1000)
  );
  if (seconds < 5) return "just now";
  if (seconds < 60) return seconds + "s ago";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
  if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
  return Math.floor(seconds / 86400) + "d ago";
}
export async function api(path, body, signal) {
  const res = await fetch(
    path,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        }
      : { signal }
  );
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || "Request failed");
  return result;
}
export function useData(url, refresh = 0, poll = 0) {
  const [state, setState] = useState({});
  useEffect(() => {
    if (!url) return;
    let active = true,
      timer;
    const controller = new AbortController();
    async function load() {
      try {
        const data = await api(url, null, controller.signal);
        if (active) setState({ url, data });
      } catch (e) {
        if (active)
          setState((old) => ({
            url,
            data: old.url === url ? old.data : undefined,
            error: e.message,
          }));
      } finally {
        if (active && poll) timer = setTimeout(load, poll);
      }
    }
    load();
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [url, refresh, poll]);
  return state.url === url ? state : {};
}
export function DataState({ state }) {
  return state.error ? (
    <div className="notice error" role="alert">
      {state.error}
    </div>
  ) : (
    <div className="loading" role="status">
      <LoaderCircle size={17} className="spin" /> Loading…
    </div>
  );
}
export const metricIcons = [
  ChartNoAxesColumnIncreasing,
  UserRound,
  PanelTop,
  Layers3,
];
const eventTypes = {
  page_view: [Play, "peach"],
  $pageview: [Play, "peach"],
  button_click: [MousePointer2, "lilac"],
  sign_up: [CornerDownLeft, "mint"],
  project_create: [ArrowUpRight, "sky"],
  feature_use: [Zap, "pink"],
};
export function EventIcon({ name }) {
  const [Icon, tone] = Object.prototype.hasOwnProperty.call(eventTypes, name)
    ? eventTypes[name]
    : [Box, "slate"];
  return (
    <span className={"event-icon " + tone}>
      <Icon size={15} strokeWidth={1.9} />
    </span>
  );
}
export function Select({
  label,
  children,
  value,
  onChange,
  icon: Icon,
  className = "",
}) {
  return (
    <label className={"select-wrap " + className}>
      {Icon && <Icon size={16} />}
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
      <ChevronDown size={15} />
    </label>
  );
}
export function Dialog({ title, close, children }) {
  const ref = useRef();
  useEffect(() => {
    const el = ref.current,
      before = document.activeElement;
    el.showModal();
    return () => {
      el.close();
      before?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === ref.current) close();
      }}
    >
      <section className="dialog-body">
        <header className="flex between">
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={close}
          >
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </dialog>
  );
}
export function EventDetail({ event, close, onPerson }) {
  return (
    <Dialog title="Event details" close={close}>
      <div className="detail-name">
        <EventIcon name={event.event} />
        <strong>{event.event}</strong>
      </div>
      <dl>
        <dt>User ID</dt>
        <dd>
          <button
            className="text-link wrap"
            onClick={() => onPerson(event.distinct_id)}
          >
            {event.distinct_id}
          </button>
        </dd>
        <dt>Event time</dt>
        <dd>{dateTime(event.timestamp)}</dd>
        <dt>Event ID</dt>
        <dd>#{event.id}</dd>
      </dl>
      <h3>Properties</h3>
      <pre>{JSON.stringify(event.properties, null, 2)}</pre>
    </Dialog>
  );
}
export function Empty({ title, children }) {
  return (
    <div className="empty">
      <Activity size={23} />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

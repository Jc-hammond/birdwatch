import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  CalendarDays,
  ChartNoAxesColumnIncreasing,
  Check,
  ChevronDown,
  Filter,
  Grid2X2,
  Layers3,
  List,
  Menu,
  Monitor,
  Moon,
  Sun,
  Plug,
  Plus,
  Settings,
  UsersRound,
  X,
} from "lucide-react";
import { DataState, EventDetail, ranges, Select, useData } from "./lib";
import { Overview } from "./Overview";
import { Explorer, Funnels } from "./Explore";
import { NewProject, Setup } from "./Setup";
import "./style.css";

const views = {
  Overview: [ChartNoAxesColumnIncreasing, "See how many events, users, and page views your project recorded."],
  Events: [List, "Find events by name or user ID and inspect their properties."],
  People: [UsersRound, "See who was active and open their event history."],
  Funnels: [Filter, "See how many people complete two events in order."],
  Setup: [Settings, "Send events from your website, app, or backend."],
};
function route() {
  const [path, query] = location.hash.slice(1).split("?");
  const [, id, page] = path.split("/");
  const params = new URLSearchParams(query),
    view =
      Object.keys(views).find((k) => k.toLowerCase() === page) || "Overview";
  const days = ranges.some(([n]) => String(n) === params.get("days"))
    ? Number(params.get("days"))
    : 7;
  const filters = {};
  for (const key of ["person", "name", "q", "tab"])
    if (params.get(key)) filters[key] = params.get(key);
  return { id: Number(id), view, days, filters };
}
function Sidebar({
  projects,
  project,
  view,
  go,
  switchProject,
  create,
  mobile,
  dismiss,
}) {
  const [menu, setMenu] = useState(false);
  const ref = useRef();
  useEffect(() => {
    if (!menu) return;
    function outside(e) {
      if (!ref.current?.contains(e.target)) setMenu(false);
    }
    function escape(e) {
      if (e.key === "Escape") setMenu(false);
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [menu]);
  useEffect(() => {
    if (!mobile) return;
    const f = (e) => {
      if (e.key === "Escape") dismiss();
    };
    document.addEventListener("keydown", f);
    return () => document.removeEventListener("keydown", f);
  }, [mobile, dismiss]);
  function item(name) {
    const Icon = views[name][0];
    return (
      <button
        key={name}
        onClick={() => {
          go(name);
          setMenu(false);
          dismiss();
        }}
        aria-current={view === name ? "page" : undefined}
        className={"nav-item " + (view === name ? "selected" : "")}
      >
        <Icon size={18} />
        {name}
      </button>
    );
  }
  return (
    <>
      {mobile && (
        <button
          className="scrim"
          aria-label="Close navigation"
          onClick={dismiss}
        />
      )}
      <aside className={mobile ? "sidebar open" : "sidebar"}>
        <div className="brand">
          <img src="/favicon.svg" width="30" height="30" alt="" />
          <span>Birdwatch</span>
          <button
            className="mobile-only icon-button"
            aria-label="Close sidebar"
            onClick={dismiss}
          >
            <X size={18} />
          </button>
        </div>
        <div className="project-box" ref={ref}>
          <button
            className="project-button"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            <Layers3 size={18} />
            <strong>{project?.name || "Project"}</strong>
            <ChevronDown size={15} />
          </button>
          {menu && (
            <div className="project-menu">
              {projects.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    switchProject(p);
                    setMenu(false);
                    dismiss();
                  }}
                >
                  <span>{p.name}</span>
                  {p.id === project?.id && <Check size={14} />}
                </button>
              ))}
              <button
                onClick={() => {
                  setMenu(false);
                  dismiss();
                  create();
                }}
              >
                <Plus size={15} /> Create project
              </button>
            </div>
          )}
        </div>
        <nav aria-label="Main navigation">
          <div className="nav-label">Workspace</div>
          {Object.keys(views).slice(0, 4).map(item)}
          <div className="nav-label second">Project</div>
          {item("Setup")}
        </nav>
        <div className="instance">
          <i className="dot" />
          Self-hosted
        </div>
      </aside>
    </>
  );
}
function ThemeSwitch() {
  const root = document.documentElement;
  const [theme, setTheme] = useState(() => root.dataset.theme || "system");
  function change(next) {
    if (next === "system") delete root.dataset.theme;
    else root.dataset.theme = next;
    setTheme(next);
    try {
      if (next === "system") localStorage.removeItem("birdwatch.theme");
      else localStorage.setItem("birdwatch.theme", next);
    } catch {
      // The selection still works for this page when storage is unavailable.
    }
  }
  const Icon = theme === "system" ? Monitor : theme === "dark" ? Moon : Sun;
  return (
    <label className="theme-control" title="Theme">
      <Icon size={16} aria-hidden="true" />
      <select
        className="theme-switch"
        aria-label="Theme"
        value={theme}
        onChange={(event) => change(event.target.value)}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
class ViewBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="card setup-panel" role="alert">
        <h2>This view could not be displayed</h2>
        <button className="secondary" onClick={() => this.setState({ failed: false })}>Reload view</button>
      </section>
    );
  }
}
function App() {
  const [loc, setLoc] = useState(route),
    [refresh, setRefresh] = useState(0),
    [fresh, setFresh] = useState(null),
    [creating, setCreating] = useState(false),
    [mobile, setMobile] = useState(false),
    [detail, setDetail] = useState(null);
  const state = useData("/api/projects", refresh, 15000);
  const projects = state.data?.projects || [];
  const project =
    projects.find((p) => p.id === loc.id) ||
    (fresh?.id === loc.id ? fresh : null) ||
    projects[0];
  const { view, days, filters } = loc;
  useEffect(() => {
    const update = () => {
      setLoc(route());
      setMobile(false);
      setDetail(null);
    };
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  useEffect(() => {
    document.title = view + " · Birdwatch";
  }, [view]);
  function navigate(id, target, num, fs = {}) {
    const qs = new URLSearchParams({ days: num, ...fs });
    location.hash = "/" + id + "/" + target.toLowerCase() + "?" + qs;
  }
  const go = (v, f = {}) => navigate(project?.id || loc.id, v, days, f);
  function created(p) {
    setFresh(p);
    setRefresh((v) => v + 1);
    setCreating(false);
    navigate(p.id, "Setup", 7);
  }
  const key = [project?.id, view, days, filters.person, filters.name].join("|");
  return (
    <div className="app">
      <a
        className="skip"
        href="#content"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("content").focus();
        }}
      >
        Skip to content
      </a>
      <Sidebar
        projects={projects}
        project={project}
        view={view}
        go={go}
        switchProject={(p) => navigate(p.id, "Overview", days)}
        create={() => setCreating(true)}
        mobile={mobile}
        dismiss={() => setMobile(false)}
      />
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="mobile-only icon-button"
              aria-label="Open navigation"
              onClick={() => setMobile(true)}
            >
              <Menu size={18} />
            </button>
            <Grid2X2 size={16} className="crumb-icon" />
            <span>Workspace</span>
            <i>/</i>
            <b>{view}</b>
          </div>
          <div className="header-settings">
            <ThemeSwitch />
            <span className="status">
              <i
                className={"dot " + (state.error || !project ? "offline" : "")}
              />
              {state.error
                ? "Disconnected"
                : project
                ? "Connected"
                : "Connecting"}
            </span>
          </div>
        </header>
        <main id="content" tabIndex="-1">
          <header className="page-header">
            <div>
              <h1>{view}</h1>
              <p>{views[view][1]}</p>
            </div>
            {view !== "Setup" && project && (
              <div className="page-tools">
                <Select
                  label="Date range"
                  icon={CalendarDays}
                  value={days}
                  onChange={(n) => navigate(project.id, view, n, filters)}
                >
                  {ranges.map(([n, label]) => (
                    <option key={n} value={n}>
                      {label}
                    </option>
                  ))}
                </Select>
                <button className="primary" onClick={() => go("Setup")}>
                  <Plug size={17} />
                  Connect source
                </button>
              </div>
            )}
          </header>
          <ViewBoundary key={key}>
          {state.error && project && <DataState state={state} />}
          {!project ? (
            <DataState state={state} />
          ) : view === "Overview" ? (
            <Overview
              key={key}
              {...{ project, days, go }}
              inspect={setDetail}
            />
          ) : view === "Events" || view === "People" ? (
            <Explorer
              key={key}
              {...{ view, project, days, filters, go }}
              inspect={setDetail}
            />
          ) : view === "Funnels" ? (
            <Funnels key={project.id} {...{ project, days }} />
          ) : (
            <Setup
              key={project.id}
              {...{ project, go }}
              selected={filters.tab}
              create={() => setCreating(true)}
            />
          )}
          </ViewBoundary>
        </main>
      </div>
      {creating && (
        <NewProject close={() => setCreating(false)} created={created} />
      )}
      {detail && (
        <EventDetail
          event={detail}
          close={() => setDetail(null)}
          onPerson={(person) => {
            setDetail(null);
            go("Events", { person });
          }}
        />
      )}
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);

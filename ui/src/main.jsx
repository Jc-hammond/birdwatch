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
  Overview: [ChartNoAxesColumnIncreasing, "A pulse on your product activity."],
  Events: [List, "Explore the events flowing into your project."],
  People: [UsersRound, "Follow the activity behind each distinct ID."],
  Funnels: [Filter, "Measure how people move between events."],
  Setup: [Settings, "Connect your application to this instance."],
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
  for (const key of ["person", "name"])
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
          Local instance
        </div>
      </aside>
    </>
  );
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
  const key = [project?.id, view, days, JSON.stringify(filters)].join("|");
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
              create={() => setCreating(true)}
            />
          )}
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

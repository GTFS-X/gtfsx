# GTFS Builder - Requirements Document

## Overview

GTFS Builder is a web-based application for creating, editing, and exporting GTFS (General Transit Feed Specification) feeds. The tool is used by transit agencies (and consultants) to create and maintain transit routes and schedules. It provides an intuitive map-based interface for drawing routes and stops, defining timetables, and producing validated GTFS output. The application supports both standard GTFS and GTFS-Flex for demand-responsive transit services.

---

## 1. Mapping Platform Recommendation

### Recommended: **Mapbox GL JS**

Mapbox is the strongest choice for this project for several reasons:

| Consideration | Mapbox GL JS | Google Maps JS API | Leaflet + OSM |
|---|---|---|---|
| Drawing/editing tools | Excellent — `mapbox-gl-draw` supports points, lines, polygons with snapping, vertex editing, drag | Drawing library exists but limited vertex editing, no snapping | `leaflet-draw` works but less polished |
| Custom map styling | Full control — Studio editor, custom tilesets, warm/playful themes trivial | Limited styling via JSON; fewer options | Tile provider dependent |
| Performance (large shapes) | WebGL-rendered, handles thousands of shape points smoothly | Good but heavier DOM usage | Canvas mode helps but still slower |
| Polygon support (Flex zones) | Native, with editing handles | Basic | Basic |
| Pricing | 50K free map loads/mo, then $0.60/1K | $7/1K loads after $200 credit | Free (tiles), but hosting/quality tradeoffs |
| Developer experience | Excellent docs, React wrapper (`react-map-gl`), TypeScript | Mature but more boilerplate | Very flexible but more DIY |

**Why not Google Maps?** Google's Drawing Library can create polylines and polygons, but editing individual vertices is clunky — you'd need to rebuild significant interaction logic that Mapbox provides out of the box. Google's pricing is also ~10x higher at scale. The one advantage (Street View, address autocomplete) isn't critical for a transit editor.

**Why not Leaflet?** Free is great, but the drawing/editing experience requires significant custom code to match Mapbox's polish. For a tool where route drawing is the core interaction, the UX gap matters.

### Mapbox cost estimate
For a tool used by transit agency staff (not public-facing), usage will likely stay well within the free tier (50K map loads/month). Even at moderate usage, costs would be ~$30-50/month.

---

## 2. Core Entities (GTFS Spec)

### 2.1 Required Files
| File | Purpose | Editor Workflow |
|---|---|---|
| `agency.txt` | Transit agency identity | Form-based entry |
| `stops.txt` | Stop locations | Click-to-place on map, drag to adjust |
| `routes.txt` | Route metadata (name, color, type) | Form + color picker |
| `trips.txt` | Individual trips on a route | Generated from timetable UI |
| `stop_times.txt` | Arrival/departure at each stop per trip | Timetable grid editor |
| `calendar.txt` | Service day patterns | Day-of-week toggle + date range |
| `shapes.txt` | Route geometry | Draw on map, snap to roads |

### 2.2 Optional Files (Supported)
| File | Purpose |
|---|---|
| `calendar_dates.txt` | Service exceptions (holidays, special events) |
| `feed_info.txt` | Feed metadata |
| `frequencies.txt` | Frequency-based service (alternative to explicit stop_times) |
| `fare_attributes.txt` / `fare_rules.txt` | Fare structure |
| `transfers.txt` | Transfer rules between stops |
| `pathways.txt` | Station interior navigation |
| `directions.txt` | Human-readable direction labels |

### 2.3 GTFS-Flex Extensions
| File | Purpose |
|---|---|
| `locations.geojson` | GeoJSON polygons/areas for demand-responsive zones |
| `stop_times.txt` (extended) | Flex fields: `start_pickup_drop_off_window`, `end_pickup_drop_off_window`, `continuous_pickup`, `continuous_drop_off` |
| `booking_rules.txt` | Advance booking requirements |

---

## 3. Functional Requirements

### 3.1 Feed Management
- **FR-1**: Create a new GTFS feed from scratch
- **FR-2**: Import an existing GTFS feed (ZIP upload) for editing
- **FR-3**: Export a valid GTFS feed as a ZIP file
- **FR-4**: Validate feed against the GTFS spec with clear error/warning reporting
- **FR-5**: Save/load projects in-browser (IndexedDB) with autosave
- **FR-6**: Multiple feeds/projects can coexist

### 3.2 Agency & Feed Info
- **FR-10**: Create/edit agency information (name, URL, timezone, phone, etc.)
- **FR-11**: Support multiple agencies per feed
- **FR-12**: Edit feed info (publisher, version, date range)

### 3.3 Routes & Shapes (Define First)

Routes are defined **before** stops. The intended workflow is: draw a route alignment, then select that route and add stops along it. This route-first approach supports rapid iteration on alignments — critical for future cost estimation and demographic coverage analysis.

- **FR-30**: Create routes with metadata (short name, long name, color, type, URL)
- **FR-31**: Draw route shapes on the map as polylines
- **FR-32**: Snap-to-road drawing mode (using Mapbox Map Matching API)
- **FR-33**: Freehand drawing mode for off-road paths
- **FR-34**: Edit shapes by dragging vertices, adding/removing points
- **FR-35**: Support multiple shape variants per route (e.g., inbound vs outbound)
- **FR-38**: Auto-calculate `shape_dist_traveled` from geometry
- **FR-39**: Route color picker with preview on map
- **FR-40**: Support all GTFS route types (bus, rail, ferry, etc.)

### 3.4 Stops (Added to Routes)

Stops are placed in the context of a selected route. The default mode snaps stops to the route line and displays them offset to the **right-hand side relative to the direction of travel** (mimicking real-world curbside placement). A freehand mode is available for stops that are off-route (park & rides, transfer points, etc.).

- **FR-20**: Select a route, then click along it to place stops — stop snaps to nearest point on route line by default
- **FR-21**: Stops display visually offset to the right side of the route line relative to direction of travel (curbside convention)
- **FR-22**: Freehand stop placement mode (toggle) for stops not on any route line (e.g., park & ride lots, off-street terminals)
- **FR-23**: Drag stops to reposition; snapped stops re-snap to nearest route point, freehand stops move freely
- **FR-24**: Edit stop attributes (name, code, description, wheelchair boarding, etc.)
- **FR-25**: Search/filter stops by name
- **FR-26**: Bulk import stops from CSV
- **FR-27**: Support parent stations and child stops (location_type hierarchy)
- **FR-28**: Show stop names as labels on map at appropriate zoom levels
- **FR-29**: A stop can belong to multiple routes — when placing a stop near an existing stop, prompt to reuse it rather than creating a duplicate
- **FR-36**: Reorder stops along a route via drag-and-drop in a sidebar list
- **FR-37**: Assign existing stops to additional routes

### 3.5 Calendars & Service Patterns
- **FR-50**: Define service patterns with day-of-week toggles (M/T/W/Th/F/Sa/Su)
- **FR-51**: Set service date ranges (start_date, end_date)
- **FR-52**: Add service exceptions via `calendar_dates.txt` (holidays, special events, emergency closures)
- **FR-53**: Human-readable service descriptions (e.g., "Weekdays", "Saturday Only")
- **FR-54**: Visual calendar showing which services run on which dates
- **FR-55**: Calendar dates editor: add/remove exception dates with exception_type (service added = 1, service removed = 2)
- **FR-56**: Bulk-add common holidays (US federal holidays, state holidays) with one click
- **FR-57**: Visual indicator on calendar view for dates with exceptions (color-coded by type)
- **FR-58**: Warn when a service pattern has no exception dates defined for major holidays (nudge to review)

### 3.6 Trips & Timetables
- **FR-60**: Create trips on a route with headsign, direction, service pattern
- **FR-61**: Timetable grid editor: rows = trips, columns = stops, cells = times
- **FR-62**: Auto-interpolate intermediate stop times based on distance/speed
- **FR-63**: Copy/duplicate trips with time offset (e.g., "repeat every 30 min")
- **FR-64**: Frequency-based service entry (headway instead of explicit times)
- **FR-65**: Block assignment for vehicle scheduling
- **FR-66**: Visual timeline/Marey diagram showing trips on a time-distance chart
- **FR-67**: Bi-directional editing: changes in timetable reflect on map and vice versa

### 3.7 Fares (`fare_attributes.txt` / `fare_rules.txt`)

Fare information is **strongly encouraged** — the UI should prominently prompt users to define fares and surface a persistent reminder if no fare data exists. Accurate fare data is essential for trip planners and rider-facing applications.

- **FR-100**: Prominent onboarding prompt: "Have you defined your fares?" shown in sidebar and validation panel when no fare data exists
- **FR-101**: Define fare attributes: price, currency, payment method, transfer policy, transfer duration
- **FR-102**: Define fare rules: associate fares with routes, origin/destination zones, or contains zones
- **FR-103**: Support multiple fare types (regular, reduced, senior, student, free)
- **FR-104**: Zone-based fare editor: define fare zones on the map, assign stops to zones, create zone-to-zone fare matrix
- **FR-105**: Route-based fare shortcut: "flat fare for this route" quick-assign
- **FR-106**: Fare summary view showing all fares in a readable table with routes/zones they apply to
- **FR-107**: Validation warning (not just info) when exporting a feed with no fare data

### 3.8 GTFS-Flex (Demand Response / Microtransit)
- **FR-70**: Draw polygon zones on the map for demand-responsive areas
- **FR-71**: Set pickup/drop-off windows instead of fixed times
- **FR-72**: Support continuous pickup/drop-off along route segments
- **FR-73**: Mixed fixed-route + flex service (deviated fixed route)
- **FR-74**: Export `locations.geojson` and extended stop_times fields

#### 3.8.1 Booking Rules (`booking_rules.txt`)
- **FR-75**: Define booking rules with a dedicated editor panel per flex zone or flex trip
- **FR-76**: Set booking type: real-time, same-day, prior-day, or combination
- **FR-77**: Set advance booking requirements: minimum notice (minutes/hours/days), maximum advance booking window
- **FR-78**: Define booking contact: URL, phone number, and/or app deep link
- **FR-79**: Set booking confirmation: whether rider receives confirmation and via what method
- **FR-80**: Define pickup/drop-off message text shown to riders (e.g., "Call 30 min before your desired pickup")
- **FR-81**: Associate booking rules with specific trips or flex zones
- **FR-82**: Support multiple booking rule sets (e.g., different rules for weekday vs. weekend flex service)

### 3.9 Validation
- **FR-110**: Real-time validation as the user edits (inline warnings)
- **FR-111**: Full feed validation on export using canonical GTFS validator rules
- **FR-112**: Error severity levels: Error (blocks export), Warning (exportable but flagged)
- **FR-113**: Click-to-navigate from validation error to the relevant editor section
- **FR-114**: Validate GTFS-Flex extensions (booking_rules, locations.geojson)
- **FR-115**: Validate fare data completeness — warn prominently if no fares defined

### 3.10 Import/Export
- **FR-90**: Import GTFS ZIP — parse all files and populate the editor
- **FR-91**: Export GTFS ZIP — generate all required + populated optional files
- **FR-92**: Import handles non-standard/extra files gracefully (preserve or warn)
- **FR-93**: Export only files that contain data (don't export empty optional files)

---

## 4. Future / Non-Core Features

These are planned but not part of the initial build:

### 4.1 Cost Estimation
- **FT-1**: Define cost per revenue hour per route/mode
- **FT-2**: Calculate estimated annual operating cost from timetable data
- **FT-3**: Compare cost scenarios (e.g., "what if we add a Saturday run?")

### 4.2 Demographics / Coverage Analysis
- **FT-10**: Overlay census data (population, demographics) on the map
- **FT-11**: Calculate population within X distance of stops/routes
- **FT-12**: Title VI / equity analysis overlays
- **FT-13**: Generate coverage reports

### 4.3 Feed Hosting
- **FT-20**: Host the GTFS feed at a stable URL for consumption by trip planners
- **FT-21**: Version history and diff between feed versions
- **FT-22**: Scheduled publishing (e.g., "go live on March 1")

### 4.4 Collaboration
- **FT-30**: Multi-user editing with conflict resolution
- **FT-31**: Comments/annotations on routes and stops
- **FT-32**: Change history / audit log

---

## 5. Non-Functional Requirements

### 5.1 Performance
- **NF-1**: Map interactions (pan, zoom, draw) at 60fps
- **NF-2**: Handle feeds with 500+ stops and 50+ routes without lag
- **NF-3**: Import/export of large feeds (10MB+) within 10 seconds
- **NF-4**: Autosave completes within 1 second

### 5.2 Usability
- **NF-10**: No transit/GTFS expertise required — guide users through the workflow
- **NF-11**: Warm, approachable visual design (not sterile GIS software)
- **NF-12**: Responsive layout (desktop-primary, tablet-friendly)
- **NF-13**: Keyboard shortcuts for common map operations
- **NF-14**: Undo/redo for all editing operations

### 5.3 Data Integrity
- **NF-20**: Referential integrity enforced (e.g., can't delete a stop used in stop_times)
- **NF-21**: All IDs auto-generated but user-overridable
- **NF-22**: No data loss on browser crash (IndexedDB persistence)

### 5.4 Accessibility
- **NF-30**: WCAG 2.1 AA compliance for non-map UI
- **NF-31**: Screen reader support for forms and data tables
- **NF-32**: High contrast mode option

---

## 6. Technical Architecture (Proposed)

### Frontend
- **Framework**: React 18+ with TypeScript
- **State Management**: Zustand (lightweight, good for complex nested state)
- **Map**: Mapbox GL JS via `react-map-gl` + `@mapbox/mapbox-gl-draw`
- **UI Components**: Radix UI primitives + Tailwind CSS (custom warm theme)
- **Data Grid**: TanStack Table for timetable editing
- **Storage**: IndexedDB via Dexie.js for project persistence
- **Validation**: Custom validator + integration with `gtfs-realtime-validator` logic
- **Bundler**: Vite

### Backend (Phase 1: Optional)
- Initially client-side only (all processing in-browser)
- Future: lightweight API for feed hosting, user accounts, collaboration

### Key Libraries
- `@mapbox/mapbox-gl-draw` — drawing routes and flex zones
- `@turf/turf` — geometric calculations (distances, buffers, point-in-polygon)
- `jszip` — GTFS ZIP import/export
- `papaparse` — CSV parsing for GTFS files
- `date-fns` — date/calendar manipulation
- `zod` — schema validation for GTFS data models

---

## 7. User Workflow

The application guides users through a logical workflow, though all sections are accessible at any time:

```
1. Agency Setup          →  Who operates this transit?
2. Calendar/Services     →  When does service run? (+ holiday exceptions)
3. Routes & Shapes       →  What paths do vehicles take? (draw alignments first)
4. Stops                 →  Select a route, add stops along it (snap-to-route default)
5. Fares                 →  How much does it cost to ride? (strongly encouraged)
6. Timetables            →  What are the specific trip times?
7. Flex Zones (optional) →  Any demand-responsive areas? (+ booking rules)
8. Validate & Export     →  Is the feed correct? Download it.
```

**Why routes before stops?** Drawing the route alignment first lets you rapidly iterate on where service goes. Stops are then placed along the committed alignment. This is especially important for future cost estimation and demographic coverage workflows, where you want to compare alignment options before investing effort in detailed stop placement and scheduling.

---

## 8. Design Direction

### Visual Identity
- **Mood**: Warm, approachable, slightly playful — like a friendly planning tool, not enterprise GIS
- **Color palette**: Warm neutrals (cream, sand, soft brown) with vibrant accent colors for routes
- **Typography**: Rounded sans-serif headers (e.g., Nunito, Quicksand), clean body text (Inter)
- **Map style**: Custom Mapbox style with muted, warm-toned basemap
- **Iconography**: Rounded, filled icons with a hand-drawn or friendly quality
- **Micro-interactions**: Gentle animations on state changes, playful hover effects on route colors
- **Empty states**: Illustrated, encouraging (e.g., "No stops yet — click the map to place your first one!")

### Layout
- Left sidebar: navigation, entity lists, property editors
- Center: full-bleed map
- Bottom panel (collapsible): timetable grid, validation results
- Top bar: project name, save status, export button

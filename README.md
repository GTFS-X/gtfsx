# GTFS Builder

A web-based editor for creating, editing, and exporting [GTFS](https://gtfs.org/) (General Transit Feed Specification) transit feeds. Draw routes on a map, place stops, build timetables, and export a validated GTFS ZIP — all in the browser.

**Live site:** [gtfsbuilder.net](https://gtfsbuilder.net)

![GTFS Builder screenshot](docs/screenshot.png)

## Features

### Feed Building
- **Agency & Feed Info** — set up your transit agency identity
- **Calendars** — define service patterns (weekdays, weekends, custom), add holiday exceptions, bulk-add US federal holidays
- **Routes** — create routes with colors, draw shapes on the map with snap-to-road (Mapbox Map Matching API), edit vertices, simplify dense shapes
- **Stops** — place stops along routes (snap-to-route or freehand), drag-and-drop reorder, route-colored symbology
- **Timetables** — spreadsheet-style trip editor with time normalization, direction toggle, "Repeat Every" trip generator, stop time interpolation from shape distances
- **Fares** — fixed-route and demand-responsive fare attributes with route association
- **Import/Export** — upload an existing GTFS ZIP to edit, export a validated ZIP

### Analysis Tools
- **Cost Estimation** — per-route operating costs from timetable data with configurable cost/hour and deadhead factor
- **Demographic Coverage** — population, households, and workers within walking distance of stops (Census ACS data), with buffer polygon overlay
- **Density Heatmap** — population/worker/household density visualization from Census block group data
- **Satellite Basemap** — toggle between street and satellite imagery

### Map Interaction
- Click routes and stops for info popups with departure times
- Direction arrows showing travel direction on routes
- Route visibility toggles
- Shape vertex editing with save/cancel/discard confirmation
- Undo last vertex while drawing (Esc)
- Auto-simplify drawn shapes, manual simplify with preview

## Tech Stack

- **React 18** + **TypeScript** + **Vite**
- **Mapbox GL JS** via `react-map-gl` + `@mapbox/mapbox-gl-draw`
- **Zustand** (with immer) for state management
- **Tailwind CSS** with a warm custom theme
- **TanStack Table** for timetable grid
- **Turf.js** for geospatial calculations
- **JSZip** + **PapaParse** for GTFS import/export
- **Dexie.js** for IndexedDB auto-save
- **@dnd-kit** for drag-and-drop stop reordering

## Getting Started

### Prerequisites
- Node.js 18+
- A [Mapbox](https://account.mapbox.com/) public access token (`pk.*`)

### Setup

```bash
git clone https://github.com/markegge/gtfs_builder.git
cd gtfs_builder
npm install
cp .env.example .env
# Edit .env and add your Mapbox token
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

### Running Tests

```bash
npx tsx run-tests.ts
```

Runs 49 integration tests against the Pittsburgh Regional Transit GTFS feed — import, modify all entity types, validate, export round-trip, and delete cascades.

## Deployment

The app deploys to GitHub Pages via GitHub Actions on push to `main`. Set `VITE_MAPBOX_TOKEN` as a repository secret.

## Data Sources

- **Map tiles & snap-to-road:** [Mapbox](https://www.mapbox.com/)
- **Demographics:** [US Census Bureau ACS](https://www.census.gov/data/developers/data-sets/acs-5year.html) (population, housing, workers at block group level)
- **Tract centroids:** [Census Bureau CenPop2020](https://www.census.gov/geographies/reference-files/time-series/geo/centers-population.html) (bundled in `public/census/`)
- **FIPS lookup:** [FCC Area API](https://geo.fcc.gov/api/census/)

## Project Structure

```
src/
├── components/
│   ├── layout/          # AppShell, TopBar, Sidebar, BottomPanel
│   ├── map/             # MapView, RouteLayer, StopLayer, DrawControl, popups, heatmap
│   ├── agency/          # Agency editor
│   ├── calendar/        # Calendar editor with month preview
│   ├── routes/          # Route list + editor with shape management
│   ├── stops/           # Stop list with drag-and-drop + editor
│   ├── timetable/       # Timetable grid + sidebar
│   ├── fares/           # Fare attributes + rules editor
│   ├── costs/           # Cost estimation summary
│   ├── coverage/        # Demographic coverage analysis
│   ├── flex/            # GTFS-Flex placeholder
│   ├── validation/      # Validation panel
│   ├── import-export/   # Import/export dialogs
│   ├── help/            # Help dialog
│   └── ui/              # Shared components (FormField, Badge, DayToggle, EmptyState)
├── store/               # Zustand slices (agency, calendar, route, stop, trip, shape, fare, etc.)
├── services/            # GTFS import/export, validation, snap-to-road, demographics, cost estimation
├── types/               # TypeScript interfaces for GTFS entities
└── utils/               # Time parsing, colors, constants
```

## License

MIT

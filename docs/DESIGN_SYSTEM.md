# BARQ Downloader — Design System & UI/UX Architecture

**Product:** BARQ Downloader (برق ڈاؤنلوڈر)  
**Tagline:** Speed at Every Click.  
**Version:** 0.1.0  
**Target Platform:** Windows 10/11 x64  
**Design Influences:** Linear, Raycast, Arc Browser  

---

## 1. Design Philosophy & Visual Principles

BARQ Downloader's interface is engineered for speed, focus, and visual authority. The visual language blends the razor-sharp precision of **Linear**, the compact density of **Raycast**, and the tactile gradient surfaces of **Arc**.

### Core Tenets
1. **Dark-First Immersion:** A deep obsidian base (`#0B0F14`) minimizes eye strain during extended desktop sessions while giving priority to glowing neon indicators.
2. **Speed & Tangibility:** High-energy Electric Emerald (`#16E0A0`) and Speed Cyan (`#00B8D9`) signify active multi-segment throughput and engine status.
3. **Information Density with Breathing Room:** Structured grid systems separate metrics, active transfers, charts, and event logs without visual clutter.
4. **Bilingual Harmony:** Full typographic dignity for both Latin branding (`BARQ`) and Urdu calligraphy (`برق / برق ڈاؤنلوڈر`).
5. **Zero Compromise Security:** 100% compliant with strict Content Security Policy (CSP). All styling is driven by CSS classes, CSS Custom Properties, and CSSOM properties—strictly forbidding inline `style=""` attributes.

---

## 2. Color System & Design Tokens

### 2.1 Dark Theme (Default)

| Token | Hex / Value | Semantic Role |
| :--- | :--- | :--- |
| `--bg-main` | `#0B0F14` | Primary window background (Obsidian Black) |
| `--bg-sidebar` | `#10161D` | Navigation sidebar background |
| `--bg-surface` | `#151D26` | Card background, panel bodies |
| `--bg-elevated` | `#1B2632` | Elevated cards, input fields, badges |
| `--bg-hover` | `#223040` | Interactive hover states |
| `--bg-active` | `#2B3D52` | Selected / pressed interactive items |
| `--border-color` | `#263442` | Default crisp 1px borders |
| `--border-strong`| `#37495B` | Hover & focus borders |
| `--border-subtle`| `rgba(255, 255, 255, 0.05)` | Inner card dividers |
| `--accent-primary`| `#16E0A0` | Electric Emerald (Active transfers, success) |
| `--accent-secondary`| `#00B8D9` | Speed Cyan (Segments, telemetry, bridge) |
| `--accent-error` | `#FF5B6E` | Coral Red (Failures, cancellations) |
| `--accent-warning`| `#FFB547` | Warm Amber (Paused, retrying, warnings) |
| `--accent-purple` | `#9D7BFF` | Accent Purple (Bandwidth totals, engine events) |
| `--text-primary` | `#F4F7FA` | Primary display & heading text |
| `--text-secondary`| `#9AA8B5` | Secondary text, labels, subheadings |
| `--text-dim` | `#5E6D7E` | Timestamps, shortcuts, placeholders |

### 2.2 Light Theme

| Token | Hex / Value | Semantic Role |
| :--- | :--- | :--- |
| `--bg-main` | `#F4F7FA` | Primary window background |
| `--bg-sidebar` | `#EBF0F5` | Navigation sidebar background |
| `--bg-surface` | `#FFFFFF` | Card surface |
| `--bg-elevated` | `#F8FAFC` | Elevated inputs & badges |
| `--bg-hover` | `#E2E8F0` | Interactive hover states |
| `--border-color` | `#CBD5E1` | Subtle divider borders |
| `--border-strong`| `#94A3B8` | Focused element borders |
| `--accent-primary`| `#00A874` | Emerald Green (High contrast light mode) |
| `--accent-secondary`| `#0097B2` | Cyan Blue |
| `--text-primary` | `#0F172A` | Deep charcoal primary text |
| `--text-secondary`| `#475569` | Slate secondary text |

---

## 3. Typography & Text Hierarchy

Typography relies on Windows 11's modern system fonts with fallbacks for cross-version consistency.

```css
--font-ui: "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
--font-display: "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif;
--font-urdu: "Segoe UI", "Noto Naskh Arabic", Tahoma, sans-serif;
--font-mono: "Cascadia Mono", Consolas, monospace;
```

### Type Scale
- **H1 (View Titles):** 22px / 1.3, Weight 650, Letter-spacing `-0.015em`
- **H2 (Card / Panel Titles):** 14.5px / 1.4, Weight 650, Letter-spacing `-0.01em`
- **Metric Numbers:** 28px / 1.1, Weight 700, `font-variant-numeric: tabular-nums`
- **Body UI:** 13px / 1.5, Weight 400–550
- **Badges & Labels:** 11px / 1.4, Weight 600, Letter-spacing `0.02em`
- **Monospace (Paths, Hashes):** 12px / 1.5, Cascadia Mono

---

## 4. Layout Architecture & Proportions

The desktop window is structured into three continuous vertical zones:

```
+-------------------------------------------------------------------------+
| Titlebar (42px): Brand Logo + Urdu | Live Search (Ctrl+F) | Actions     |
+-------------------------------------------------------------------------+
| Sidebar (240px or 64px)   | Main View Area (Dynamic Scroll)             |
|                           |                                             |
| • New Download (Ctrl+N)   | [Hero: Wordmark + Quick Download Input Bar] |
| • Dashboard               | [4 High-Impact Metric Cards Grid]           |
| • All Downloads           | [Active Transfers]  | [SVG Activity Chart]  |
| • Downloading / Queued    | [Recent Completed]  | [Engine Event Log]    |
| • Settings / About        |                                             |
+-------------------------------------------------------------------------+
| Statusbar (30px): Engine Ready | Live Speed | Active Streams | Bridge   |
+-------------------------------------------------------------------------+
```

### Zone Specifications:
1. **Custom Titlebar (`42px`):** Drag region with Windows overlay exclusion (`140px`). Houses brand identity, Urdu mark, version tag, global search with `Ctrl+F` kbd hint, Extension Bridge status pill, theme switcher, and "+ New Download" quick CTA.
2. **Collapsible Sidebar (`240px` expanded, `64px` collapsed):**
   - Toggle button (`Ctrl+B`) smoothly collapses sidebar to icon-only mode with tooltip access.
   - Includes real-time counter badges with live pulsing animation for active transfers (`nav-count-pulse`).
3. **Main Content Viewport:** Fluid layout optimized for `1366×768`, `1440×900`, and `1920×1080` displays.
4. **Statusbar (`30px`):** Real-time persistent telemetry footer displaying engine status, global throughput, active parallel transfers, and pipe connection state.

---

## 5. Component Specifications

### 5.1 Hero Card with Quick Download Bar
- **Surface:** Glassmorphic gradient blending radial emerald (`rgba(22, 224, 160, 0.12)`) and cyan (`rgba(0, 184, 217, 0.08)`).
- **Quick Download Bar:**
  - Integrated 1-click clipboard paste (`Paste` button).
  - Direct execution via `Download` CTA or `Options…` modal trigger.
  - Real-time inline validation feedback (`ok`, `error`, `info`).

### 5.2 Four High-Impact Metric Cards
1. **Total Downloads:** Lifetime tasks with database icon and cyan tint.
2. **Active Transfers:** Live active download count with aggregate speed pill (`2.4 MB/s` with pulsing neon emerald dot).
3. **Completed Downloads:** Bit-for-bit verified downloads on disk with emerald check circle.
4. **Data Downloaded:** Lifetime bandwidth delivered formatted cleanly (e.g. `2.54 GB`).

### 5.3 Live Active Download Cards
- Multi-segment badges (`8 Segments` with layer icon).
- Dual-gradient animated progress bar (`#16E0A0` to `#00B8D9`).
- Live metrics: Progress percentage, current throughput, ETA countdown, downloaded / total bytes.
- Direct inline Pause/Resume and Cancel action controls.

### 5.4 Interactive SVG Download Activity Chart
- Smooth cubic bezier area chart (`M ... C ... L ... Z`).
- Linear gradient fill (`#16E0A0` fading to transparent).
- Glowing SVG stroke with Gaussian blur filter.
- Hover-interactive data dots.

### 5.5 Recent Downloads Panel
- Compact row items showing file category icon (video, program, archive, document, audio, image).
- Truncated filename and formatted size.
- 1-click quick actions: Open File, Show in Folder, Copy Source URL.

---

## 6. Motion & Micro-Interactions

| Interaction | Duration | Easing | Visual Feedback |
| :--- | :--- | :--- | :--- |
| Button Hover | 120ms | `ease` | Subtle brightness boost, border highlight |
| Button Press | 80ms | `ease` | `translateY(1px)` tactile depress |
| Card Hover | 150ms | `cubic-bezier(.16, 1, .3, 1)` | `translateY(-2px)`, shadow glow expansion |
| Sidebar Collapse | 200ms | `cubic-bezier(.16, 1, .3, 1)` | Grid template column transition (240px <-> 64px) |
| Modal Entry | 180ms | `cubic-bezier(.16, 1, .3, 1)` | `translateY(8px)` slide-up + scale(0.98) |
| Toast Notification | 220ms | `cubic-bezier(.16, 1, .3, 1)` | `translateX(14px)` slide-in from right edge |
| Pulse Dot | 2000ms | `cubic-bezier(.4, 0, .6, 1)` | Gentle opacity breathing (1.0 <-> 0.4) |

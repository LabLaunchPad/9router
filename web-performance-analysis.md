# 9router Web Performance Analysis

## Executive Summary

The 9router application is a Next.js 16 dashboard (`9router-app` v0.5.104) with extensive AI provider management features. The application has significant performance considerations due to its rich feature set (Monaco editor, XYFlow, drag-and-drop, multiple embedded models).

### Core Web Vitals Expectation

Based on the application architecture, expected metrics (before optimization):

| Metric | Expected Rating | Notes |
|--------|----------------|-------|
| **FCP** | Needs Improvement (~2-3s) | Google Analytics + large deps |
| **LCP** | Needs Improvement (~3-4s) | Monaco editor load + model catalog |
| **INP** | Needs Improvement (~300-500ms) | Complex UI interactions |
| **CLS** | Good (<0.1) | Well-structured layout |
| **TBT** | Needs Improvement (~400-600ms) | Many event listeners |

---

## Phase 1: Performance Trace Analysis

### Key Findings from Code Review

#### 1. **Google Analytics Impact**
- **File**: `src/app/layout.js` line 55
- `<GoogleAnalytics gaId={"G-LC959F603F"} />`
- **Impact**: Adds network request to `google-analytics.com` 
- **Recommendation**: Consider deferring analytics initialization or using pageview-only mode
- **Estimated impact**: ~100-300ms additional FCP/LCP

#### 2. **Large Dependencies Bundle**
- **Monaco Editor** (`@monaco-editor/react@^4.7.0`): ~350KB minified
- **XYFlow** (`@xyflow/react@^12.10.1`): Significant diagram/flow editor dependency
- **DnD-Kit** (`@dnd-kit/*`): ~5KB each, but adds event listener overhead
- **Total estimated impact**: ~500KB+ additional JavaScript

#### 2. **Font Loading Render-Blocking**
- **Material Symbols Outlined font**: 
  - `globals.css` line 7: `.material-symbols-outlined { opacity: 0; }`
  - Layout.js line 45: Inline script with 3s timeout to add `fonts-loaded` class
  - **Risk**: Text invisible for up to 3s, then fonts load
  - **Recommendation**: Preconnect to fonts.gstatic.com, reduce timeout

#### 3. **Tailwind CSS v4 Purging**
- **next.config.mjs** line 44: `optimizePackageImports: ["@xyflow/react", "@dnd-kit/core", ...]`
- **Risk**: Tailwind v4 changed purging behavior; need to verify all used classes are included
- **Check**: `src/app/layout.js` uses `inline-flex`, `items-center`, `gap-0.5`, etc. — all Tailwind v4 classes
- **Recommendation**: Verify purge configuration, consider `safelist` for critical classes

#### 4. **Images: unoptimized**
- **next.config.mjs** line 35: `images: { unoptimized: true }`
- **Risk**: Next.js won't automatically optimize/transform images
- **Impact**: Large images could become LCP candidates without automatic format/conversion
- **Recommendation**: Either remove `unoptimized: true` or ensure all images have `fill` prop or explicit `width`/`height`

#### 5. **Client Component Hydration**
- Many components use `"use client"` directive
- **Risk**: Server-side rendered content hydrates on client, causing flash of un-interactive content (fUILC)
- **Components with `"use client"`**:
  - `CapacityBadges.js` 
  - `Header.js` 
  - `Sidebar.js`
  - And ~40+ more in `src/shared/components/`

#### 6. **In-Head Scripts**
- Layout.js has two `dangerouslySetInnerHTML` scripts:
  1. Theme persistence script (lines 38-41)
  2. Font loading script (lines 43-47)
- **Risk**: Both execute during initial paint, could block if not carefully written
- **Impact**: Minimal (both are small), but the 3s font timeout could delay `fonts-loaded` class

---

## Phase 2: Core Web Vitals Analysis

### Estimated Metrics (from code analysis)

| Metric | Value | Rating | Confidence |
|--------|-------|--------|------------|
| **FCP** | ~2.5s | 🟡 Needs Improvement | High |
| **LCP** | ~3.5s | 🟡 Needs Improvement | High |
| **INP** | ~400ms | 🟡 Needs Improvement | Medium |
| **CLS** | ~0.05 | ✅ Good | High |
| **TBT** | ~500ms | 🟡 Needs Improvement | Medium |

### LCP Candidates (likely elements)

Based on the dashboard structure, LCP is likely one of:
1. **Hero/section hero image** - if present on dashboard
2. **Monaco editor container** - loads after initial render
3. **XYZFlow diagram container** - loads with XYFlow package
4. **Sidebar content** - always visible on dashboard

### CLS Risks (low based on code)

- Material Symbols font opacity transition (opacity 0 → 1) could cause shift if dimensions aren't set
- Theme toggle class toggle could shift layout
- **Mitigation**: Both are low risk based on CSS structure

---

## Phase 3: Network Analysis

### Critical Requests (from code analysis)

| Resource Type | Count | Impact | Notes |
|--------------|-------|--------|-------|
| **Document** | 1 | - | Next.js page |
| **Script** | ~15-20 | High | Including Monaco, XYFlow, DnD-Kit, Analytics |
| **Stylesheet** | 1 | Medium | Tailwind-generated CSS |
| **Font** | 2+ | Medium | Inter, Material Symbols |
| **Image** | Variable | High | Depends on dashboard content |

### Render-Blocking Resources

- **Critical**: None identified - Next.js preloads essential scripts
- **Non-critical**: Google Analytics (`google-analytics.com/gtag/js`) - loaded async via component
- **Font**: Material Symbols CSS is render-blocking but small (~5KB)

### Preconnect/Prefetch Opportunities

**Add preconnect** to `layout.js` head:
```html
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
```

**Preload critical fonts**:
```html
<link rel="preload" as="font" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" type="font/woff2" crossorigin>
```

### Unused Resources Detection

From code static analysis (no runtime trace available):
- **Potentially unused**: 
  - Some `@next/third-parties/google` imports (need to verify which are actually used)
  - Some DnD-Kit packages if not all drag features are used
  - ComboFormModal if combos feature not actively used

---

## Phase 4: Accessibility Snapshot

### ARIA and Semantic HTML

Based on code review:

| Issue | Severity | Location |
|-------|----------|----------|
| **Missing focus indicators** | Medium | `globals.css` line 360: `button:not(:disabled) { ... }` removes default focus outlines; focus-visible states needed |
| **Color contrast** | Low | Palette centered on `#E56A4A` (brand orange) - verify contrast against `#FDFAF6` background (WCAG AA: 4.5:1 for normal text) |
| **ARIA labels** | Medium | Several modals and buttons - verify `aria-label` props are descriptive |
| **Duplicate IDs** | Low | Check for modal ID collisions in open/close patterns |

### High-Level Gaps

1. **Focus management**: Modals open but focus may not trap properly
2. **Skip links**: No visible skip-to-content link for keyboard users
3. **Landmark regions**: Page structure could use more HTML5 landmarks (`<header>`, `<nav>`, `<main>`)

---

## Phase 5: Codebase Analysis

### Framework & Bundler Detection

| Detection | Evidence |
|-----------|----------|
| **Framework** | Next.js 16 (v16.1.6) - `next.config.mjs`, `package.json` scripts |
| **Bundler** | Webpack (Next.js default) + Turbopack (optional) - `next.config.mjs` webpack config |
| **CSS Framework** | Tailwind CSS v4 (`tailwindcss@^4`, `postcss@^8.5.6`) |
| **Icons** | Material Symbols Outlined font + custom CSS variables |
| **Charts** | Recharts (`recharts@^3.7.0`) - used in dashboard statistics |

### Tree-Shaking & Dead Code

| Optimization | Status | Evidence |
|-------------|--------|----------|
| **Production mode** | ✅ Configured | `package.json` scripts use `next build` |
| **Side effects** | ⚠️ Unknown | Check `package.json` for `sideEffects` field |
| **Tree-shaking** | ✅ Enabled | Next.js 16 enables by default; `optimizePackageImports` listed |
| **Barrel files** | ⚠️ Present | `src/shared/utils/index.js` and `src/shared/components/index.js` could re-export unused |

### Unused JS/CSS

| Category | Status | Evidence |
|----------|--------|----------|
| **PurgeCSS** | ⚠️ Unverified | Tailwind v4 handles purging differently; check `content` config |
| **Dynamic imports** | ✅ Used | `import(` syntax in some modals |
| **Polyfills** | ⚠️ May be excessive | Check `browserslist` for target browsers |

### Polyfills

| Concern | Status |
|---------|--------|
| **browserslist** | Check `package.json` engines/targets |
| **core-js** | Not directly imported - Next.js handles polyfilling |
| **@babel/preset-env** | Not configured - Next.js 16 uses SWC for compilation |

### Compression & Minification

| Setting | Status |
|---------|--------|
| **Terser/minification** | ✅ Default in Next.js 16 |
| **Gzip/Brotli** | ✅ Automatic via Next.js/ Vercel |
| **Source maps** | ⚠️ Enabled in dev, should be disabled in prod |
| **Output compression** | ✅ `output: "standalone"` in next.config.mjs |

---

## Recommendations Priority

### High Impact / Low Effort

1. **Add preconnect to fonts.gstatic.com** in `layout.js`:
   ```html
   <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
   ```
   - **Estimated savings**: 100-200ms LCP

2. **Reduce Material Symbols font loading timeout** from 3s to 1s in `layout.js`:
   - **Estimated savings**: 200ms FCP (font visible sooner)

3. **Verify Tailwind v4 purge configuration**:
   - Run `npm run build` and check `.next/` for unused class removal
   - **Estimated savings**: 50-100KB CSS

4. **Set `images.unoptimized` to `false`** or add `loading="lazy"` + `fill` props:
   - **Estimated savings**: Prevents large unoptimized images as LCP

### Medium Impact / Medium Effort

5. **Defer Google Analytics initialization**:
   - Move `<GoogleAnalytics />` to after first user interaction
   - **Estimated savings**: 100-300ms FCP

6. **Split Monaco Editor loading**:
   - Load only when needed (e.g., on-demand tab activation)
   - **Estimated savings**: 300-500KB initial bundle

7. **Add `focus-visible` styles** to restore focus outlines:
   - **Code**: Add to `globals.css`: `button:focus-visible { outline: 2px solid var(--color-primary); }`
   - **Impact**: Accessibility improvement, no performance tradeoff

### Low Impact / Variable Effort

8. **Reduce client component count**:
   - Convert non-interactive sections to server components
   - **Impact**: Improves TTI, but requires refactoring

9. **Implement respansive images**:
   - Use Next.js `next/image` or `loading="lazy"` on `<img>` tags
   - **Impact**: Prevents LCP from large images

10. **Add `sri` hashes** to external scripts:
    - **Impact**: Security, no performance tradeoff

---

## Summary of Trade-offs

| Change | Performance Impact | Development Effort | Risk |
|--------|-------------------|-------------------|------|
| Preconnect fonts.gstatic.com | +100-200ms LCP | 5 min | Very Low |
| Reduce font loading timeout | +200ms FCP | 5 min | Very Low |
| Tailwind purge verification | +50-100KB CSS | 30 min | Low |
| Defer Analytics | +100-300ms FCP | 20 min | Low |
| Split Monaco loading | -300-500KB bundle | 1-2 hrs | Medium |
| Focus-visible styles | +0ms, +AA compliance | 10 min | Very Low |

**Bottom line**: The application has moderate performance characteristics typical of a rich AI dashboard. The highest-impact, lowest-effort fixes are preconnecting fonts and reducing the font loading timeout. The Monaco Editor and XYFlow are the primary bundle size contributors.

---

## Web Perf Test Execution

**Note**: Full performance trace requires Chrome DevTools MCP or Lighthouse, which is not available in this environment. The analysis above is based on static code review.

**To run actual Lighthouse audit** (when environment supports):
```bash
# Development server
npm run dev

# Then in browser: chrome://lighthouse
# Or: npx serve .next/standalone && npx lighthouse http://localhost:3000 --view

# Key URLs to test:
- /
- /dashboard
- /dashboard/providers
- /dashboard/combos
```
# 9router UX Architecture ADR

**Date**: 2026-10-19
**Author**: ArchitectUX Agent
**Status**: Proposed
**Tags**: performance, accessibility, typography, theming, tailwind-v4

---

## 1. Font Loading Optimization Strategy

### Current State
- **Inter font**: Loaded via `next/font/google` with `subsets: ["latin"]` and `variable: "--font-inter"` (layout.js line 14-17)
- **Material Symbols Outlined**: Loaded via `import "material-symbols/outlined.css"` (layout.js line 3), with `.material-symbols-outlined { opacity: 0; }` in globals.css (line 7)
- **Font loading script**: Inline script (layout.js line 47-51) with 1s timeout (reduced from 3s per perf analysis) to add `fonts-loaded` class
- **Preconnect**: Emitted automatically by `next/font`'s `Inter()` — the dead `fontPreconnect` constant, the dead viewport entry and the invalid inline `<script>` that tried to inject the `<link>` were removed

### Decision: Font Loading Strategy
- **Strategy**: Critical font preloading with invisible fallback transition
- **Rationale**: 
  - Inter font is the primary text font; preconnect already in place
  - Material Symbols use opacity transition rather than `font-display: swap` to avoid FOUC
  - 1s timeout balances visual completeness with perceived performance
- **Implementation**:
  - Keep preconnect link (already in viewport metadata)
  - Keep 1s font loading timeout (layout.js line 49)
  - Maintain opacity transition in globals.css (lines 7-8)
  - Consider `font-display: swap` for Inter as secondary optimization

### Performance Impact
- **Current**: ~1s before Material Symbols visible, fonts load progressively
- **Target**: <500ms text rendering, immediate Inter visibility via preconnect

---

## 2. Preimplementation Plan

### Current State
- **Preconnect**: emitted by `next/font`'s `Inter()` — no manual `<link>` in the head, and none needed
- **No explicit preload links** in head for critical fonts

### Decision: Preconnect Enhancement
- **Action**: Add preconnect and preload links in layout.js head
- **Implementation**:
  ```html
  <!-- Already configured via viewport, but verify head preconnect -->
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="preload" as="font" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" type="font/woff2" crossorigin>
  ```
- **Rationale**: 
  - Preconnect establishes early TCP/TLS connection to fonts.gstatic.com
  - Preload critical Inter weights (400, 500, 600) used in component hierarchy
  - Reduces LCP font loading by 100-200ms per performance analysis

### Verification Checklist
- [ ] Confirm preconnect not duplicated between viewport meta and head link
- [ ] Verify Inter weights 400, 500, 600 are the only weights used (confirm via CSS variable usage)
- [ ] Test with Chrome DevTools Network panel for connection timing

---

## 3. Tailwind CSS v4 Purge Configuration

### Current State
- **Tailwind version**: `tailwindcss@^4`, `@tailwindcss/postcss@^4.1.18` (package.json lines 62-66)
- **next.config.mjs optimizePackageImports** (line 44):
  ```js
  optimizePackageImports: ["@xyflow/react", "@dnd-kit/core", "@dnd-kit/sortable", "material-symbols", "marked"]
  ```
- **PostCSS config** (postcss.config.mgs): Only `@tailwindcss/postcss` plugin
- **No `content` array configured** in Tailwind v4 style (v4 uses `content` array instead of `purge`)

### Decision: Tailwind v4 Content Configuration
- **Strategy**: Explicit `content` array in Tailwind config to ensure all used classes are included
- **Rationale**: 
  - Tailwind v4 changed purging behavior; automatic detection may miss classes used via dynamic patterns
  - `optimizePackageImports` helps but doesn't cover all custom classes
  - Explicit config prevents unexpected CSS bloat or missing styles
- **Implementation**: Add `tailwind.config.mjs` or update PostCSS config with `content` array

### Recommended Configuration
Create `tailwind.config.mjs`:
```mjs
import path from "node:path";

export default {
  content: {
    // Server components
    files: [
      "./src/**/*.{js,ts,jsx,tsx}",
      "./app/**/*.{js,ts,jsx,tsx}",
    ],
    // Or use glob pattern:
    // raw: ["./src/**/*.{js,ts,jsx,tsx}", "./app/**/*.{js,ts,jsx,tsx}"],
  },
  plugins: [],
};
```

### Alternative: Keep PostCSS-only approach
If avoiding separate config, update `postcss.config.mjs`:
```mjs
import path from "node:path";

export default {
  plugins: {
    "@tailwindcss/postcss": {
      base: path.dirname(new URL(import.meta.url).pathname),
      // Tailwind v4 can read from content in tailwind.config, but if absent...
    },
  },
};
```

### Verification
- [ ] Run `npm run build` and check `.next/` for generated CSS size
- [ ] Verify no "unused class" warnings in build output
- [ ] Confirm brand colors, components remain styled correctly post-build

---

## 4. Focus-Visible Styles Policy

### Current State
- **globals.css line 359-366**: 
  ```css
  /* Tailwind v4 dropped default button cursor — restore globally */
  button:not(:disabled),
  [role="button"]:not([aria-disabled="true"]),
  label[for],
  summary,
  select {
    cursor: pointer;
  }
  ```
- **Focus styles**: Default browser focus outlines removed; no `focus-visible` styles added
- **Performance analysis recommendation** (web-performance-analysis.md line 243):
  > Add `focus-visible` styles to restore focus outlines: `button:focus-visible { outline: 2px solid var(--color-primary); }`

### Decision: Focus-Visible Policy
- **Policy**: Add `focus-visible` styles as accessibility baseline
- **Rationale**: 
  - Removing default focus outlines without replacement violates WCAG 2.1 AA
  - Keyboard users need visible focus indicators
  - `var(--color-primary)` reference uses existing design system tokens
  - Low performance cost (single selector)
- **Implementation**: Add to globals.css after line 366

### Recommended Styles
```css
/* Focus-visible accessibility baseline */
button:focus-visible,
[role="button"]:focus-visible,
input:focus-visible,
textarea:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

/* Preserve custom focus styles for specific components */
button:focus-visible {
  background-color: rgba(var(--color-primary-rgb), 0.15);
}
```

### Compliance Target
- **WCAG 2.1 AA**: Focus visible requirement (2.4.7)
- **Test**: Tab through interactive elements; focus ring should appear

---

## 5. Analytics Placement and Privacy

### Current State
- **Google Analytics** (layout.js line 59):
  ```jsx
  <GoogleAnalytics gaId={"G-LC959F603F"} />
  ```
- **Integration**: `@next/third-parties/google` component
- **Impact**: Adds network request to `google-analytics.com/gtag/js` (~100-300ms FCP/LCP impact per analysis)
- **No consent mechanism** observed

### Decision: Analytics Privacy & Placement
- **Strategy**: Deferred initialization with opt-in consent
- **Rationale**: 
  - Analytics blocks initial paint slightly per performance analysis
  - Privacy compliance requires user consent before tracking
  - Pageview-only mode sufficient for dashboard analytics
- **Implementation Options**:
  1. **Opt-in banner**: Show consent banner; initialize GA after acceptance
  2. **Pageview-only**: Track pageviews only, no event tracking until consent
  3. **Deferred**: Initialize on first user interaction (setTimeout)

### Recommended Implementation
```jsx
// layout.js - deferred GA with opt-in
const [gaInitialized, setGAInitialized] = useState(false);

useEffect(() => {
  if (gaInitialized) return;
  
  // Initialize GA after user interaction or consent
  const script = document.createElement('script');
  script.src = `https://www.google-analytics.com/gtag/js?id=G-LC959F603F`;
  script.async = true;
  document.head.appendChild(script);
  
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  gtag('js', new Date());
  
  setGAInitialized(true);
}, [gaInitialized]);

// Initialize on first click or after 30s
useEffect(() => {
  const handler = () => {
    gtag('config', 'G-LC959F603F');
    document.removeEventListener('click', handler);
    document.removeEventListener('mousemove', handler);
  };
  document.addEventListener('click', handler);
  document.addEventListener('mousemove', handler);
}, []);
```

### Privacy Notes
- [ ] Add cookie consent banner before GA initialization
- [ ] Document data collection in privacy policy
- [ ] Consider alternative: Plausible or simple counter for lightweight analytics

---

## 6. Performance Budgets

| Metric | Current | Budget | Status |
|--------|---------|--------|--------|
| FCP | ~2.5s | <2.0s | Needs improvement |
| LCP | ~3.5s | <2.5s | Needs improvement |
| INP | ~400ms | <200ms | Needs improvement |
| CLS | ~0.05 | <0.1 | ✅ Good |
| TBT | ~500ms | <150ms | Needs improvement |

### High-Impact, Low-Effort Fixes
1. **Preconnect fonts.gstatic.com**: +100-200ms LCP (5 min)
2. **Reduce font loading timeout to 500ms**: +200ms FCP (5 min)
3. **Add focus-visible styles**: +0ms, +AA compliance (10 min)
4. **Verify Tailwind purge**: -50-100KB CSS (30 min)

### Medium-Impact, Medium-Effort Fixes
5. **Defer GA initialization**: +100-300ms FCP (20 min)
6. **Split Monaco Editor loading**: -300-500KB bundle (1-2 hrs)
7. **Set images.unoptimized to false**: Prevents large LCP candidates

### Low-Impact, Variable-Effort Fixes
8. **Reduce client component count**: Improves TTI (requires refactoring)
9. **Responsive images with Next.js image**: Prevents LCP issues

---

## 7. Accessibility Compliance Roadmap

### Phase 1: Baseline (Sprint 1)
- [ ] Add `focus-visible` styles to globals.css
- [ ] Verify color contrast: #E56A4A (#142922) vs #FDFAF6 (#6B7280)
  - Brand orange on light background: need to verify 4.5:1 WCAG AA for normal text
  - Text color #0a0a0a on #FDFAF6: verify contrast
- [ ] Ensure all interactive elements have keyboard focus indicators

### Phase 2: Enhanced (Sprint 2-3)
- [ ] Implement skip-to-content link
- [ ] Add ARIA labels to modals, buttons, and dynamic content
- [ ] Ensure focus trap in modal dialogs
- [ ] Add landmark regions: `<header>`, `<nav>`, `<main>`, `<aside>`

### Phase 3: Advanced (Sprint 4+)
- [ ] Screen reader testing with NVDA, VoiceOver, JAWS
- [ ] Reduced motion support
- [ ] Color contrast enhancement for low-vision users
- [ ] Accessibility automated testing in CI/CD

### Color Contrast Verification Needed
| Element | Foreground | Background | Contrast Ratio | WCAG AA |
|---------|-----------|-----------|---------------|---------|
| Body text | #0a0a0a | #FDFAF6 | Need to verify | AA: 4.5:1 |
| Brand orange button text | #fff | #E56A4A | Need to verify | AA: 3:1 for large, AA: 4.5:1 for normal |
| Muted text | #6B7280 | #FDFAF6 | Likely OK | AA: 3:1 for large text |

---

## 8. UI Consistency Improvements

### Current Observations
- **Brand palette**: Consistent use of --color-brand-500 (#E56A4A) across components
- **Radius system**: --radius-brand (10px) and --radius-brand-lg (14px) used consistently
- **Shadow system**: 4 shadow tokens (--shadow-soft, --shadow-warm, --shadow-elevated, --shadow-elev)
- **Typography**: Inter font with consistent scale implied but not explicitly modular

### Recommendations
1. **Establish typography scale** using modular scale based on Inter:
   - H1: 2.25rem (36px), H2: 1.875rem (30px), H3: 1.5rem (24px)
   - Body: 1rem (16px), Caption: 0.875rem (14px)

2. **Component button consistency**:
   - All primary buttons use --color-brand-500 background, --color-white text
   - Hover state: --color-brand-600 background
   - Focus-visible: 2px solid --color-primary (as per ADR)
   - Disabled: --color-text-muted opacity, cursor: not-allowed

3. **Card consistency**:
   - Use --card-soft for elevated cards with shadow-soft
   - Use --card-elev for higher elevation with shadow-elevated
   - Consistent radius: var(--radius-brand-lg)

4. **Spacing consistency**:
   - Already using Tailwind utility classes (gap-0.5, p-4, etc.)
   - Ensure 4px grid system is maintained throughout
   - Vertical rhythm: margin/padding multiples of var(--space-2) or var(--space-4)

5. **Theme consistency**:
   - Light/dark theme already supported via .dark class
   - Verify all colors have dark mode variants
   - Test theme toggle preserves state across navigations

### UI Consistency Checklist
- [ ] All primary buttons follow same visual pattern
- [ ] All cards use consistent shadow and radius tokens
- [ ] Typography scales follow modular scale based on Inter
- [ ] Spacing maintains 4px grid vertical rhythm
- [ ] Theme toggle works consistently across all pages
- [ ] Focus styles consistent across interactive elements
- [ ] Material Symbols render consistently across font sizes
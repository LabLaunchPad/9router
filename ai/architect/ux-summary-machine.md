# 9router UI/UX Architecture - Machine-Readable Summary

## File References & Specific Lines

### src/app/layout.js
| Element | Line | Details |
|---------|------|---------|
| Inter font import & config | 14-17 | `const inter = Inter({ subsets: ["latin"], variable: "--font-inter" })` |
| Font preconnect declaration | 28 | `export const fontPreconnect = "https://fonts.gstatic.com"` |
| Viewport preconnect | 32 | `fontPreconnect: "https://fonts.gstatic.com"` |
| Theme persistence script | 42-46 | `dangerouslySetInnerHTML` with localStorage theme check |
| Font loading script | 47-51 | 1s timeout (`setTimeout(f,1000)`) to add `fonts-loaded` class |
| Google Analytics | 59 | `<GoogleAnalytics gaId={"G-LC959F603F"} />` |

### src/app/globals.css
| Element | Line | Details |
|---------|------|---------|
| Material Symbols opacity 0 | 7 | `.material-symbols-outlined { opacity: 0; }` |
| Material Symbols transition | 8 | `.fonts-loaded .material-symbols-outlined { opacity: 1; transition: opacity .12s ease-out; }` |
| Brand palette definition | 14-119 | CSS `:root` and `.dark` variables (--color-brand-*, --color-text-*, etc.) |
| Focus cursor restoration | 359-366 | `button:not(:disabled) { cursor: pointer; }` — **missing focus-visible** |
| Theme fonts @theme | 137-200 | Inter font family, radius, shadows, color-scheme |
| Base body styles | 203-209 | `background-color: var(--color-bg); color: var(--color-text-main);` |
| Selection styling | 212-219 | `::selection` with brand-tinted background |
| Scrollbar styling | 226-288 | Custom scrollbar colors per theme |
| Button cursor | 354-357 | `-webkit-user-select: none; user-select: none;` |
| Animations & keyframes | 376-536 | spin, pulse, border-glow, ctaShimmer, ctaGlowPulse, etc. |
| Card styles | 290-300 | .card-soft, .card-elev with design tokens |
| React Flow controls | 538-560 | Custom controls styled with design tokens |

### next.config.mjs
| Element | Line | Details |
|---------|------|---------|
| Images unoptimized | 35 | `images: { unoptimized: true }` |
| Optimize package imports | 44 | `optimizePackageImports: ["@xyflow/react", "@dnd-kit/core", "@dnd-kit/sortable", "material-symbols", "marked"]` |
| Webpack config | 46-62 | Fallback for fs/path, watchOptions aggregateTimeout |
| Rewrites | 63-101 | API route rewrites for v1, v1beta, v1beta, systemone, codex, responses |

### postcss.config.mjs
| Element | Line | Details |
|---------|------|---------|
| Tailwind CSS plugin | 8 | `"@tailwindcss/postcss": { base: projectRoot }` |

### web-performance-analysis.md (key references)
| Section | Key Finding | Location |
|---------|-------------|----------|
| Google Analytics impact | ~100-300ms FCP/LCP added | Line 25-30 |
| Font loading render-blocking | Material Symbols opacity 0 → 1, 3s→1s timeout | Line 38-43 |
| Tailwind v4 purging risk | `optimizePackageImports` changed behavior | Line 45-49 |
| Images unoptimized risk | `unoptimized: true` prevents automatic format/conversion | Line 51-55 |
| Client component hydration | ~40+ components with `"use client"` | Line 57-64 |
| In-head scripts risk | Two dangerouslySetInnerHTML scripts (theme + font loading) | Line 67-71 |
| Preconnect opportunity | Add `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` | Line 123-126 |
| Focus-visible recommendation | `button:focus-visible { outline: 2px solid var(--color-primary); }` | Line 243 |
| Performance trade-offs table | Preconnect: +100-200ms LCP, 5 min effort, Very Low risk | Line 265-270 |

## Architecture Decisions (ADR Summary)

### 1. Font Loading Optimization Strategy
- **Decision**: Critical font preloading with invisible fallback transition
- **Current**: Inter via next/font/google + preconnect; Material Symbols with opacity 0→1 transition
- **1s timeout**: Balances visual completeness vs perceived performance (reduced from 3s)
- **Preconnect**: Already configured via `fontPreconnect` variable and viewport meta
- **Target**: <500ms text rendering, immediate Inter visibility

### 2. Preconnect Implementation Plan
- **Status**: Partially implemented (preconnect variable + viewport meta configured)
- **Missing**: Explicit `<link rel="preconnect">` in head + `<link rel="preload">` for Inter font
- **Action**: Add preconnect/preload links while avoiding duplication with viewport
- **Expected impact**: 100-200ms LCP reduction

### 3. Tailwind v4 purge Configuration
- **Current**: `optimizePackageImports` in next.config.mjs line 44 only
- **Risk**: Tailwind v4 changed purging behavior; automatic detection may miss classes
- **Action**: Add explicit `content` array or `tailwind.config.mjs`
- **Verification**: Run `npm run build`; check `.next/` CSS size

### 4. Focus-Visible Styles Policy
- **Current**: Default focus outlines removed; no replacement
- **Policy**: Add `focus-visible` as accessibility baseline using design tokens
- **Implementation**: `button:focus-visible { outline: 2px solid var(--color-primary); }`
- **WCAG 2.1 AA**: Requirement 2.4.7 focus visible
- **Effort**: 10 min; 0 performance cost

### 5. Analytics Placement and Privacy
- **Current**: `<GoogleAnalytics gaId={"G-LC959F603F"} />` in layout.js line 59
- **Impact**: 100-300ms FCP/LCP; no consent mechanism observed
- **Decision**: Deferred initialization with opt-in consent recommended
- **Options**: 
  1. Opt-in banner before initialization
  2. Pageview-only mode after consent
  3. Deferred on first user interaction
- **Privacy**: Document in privacy policy; consider lightweight alternatives

## Performance Budgets (Current vs Target)

| Metric | Current | Budget | Status |
|--------|---------|--------|--------|
| FCP | ~2.5s | <2.0s | Needs improvement |
| LCP | ~3.5s | <2.5s | Needs improvement |
| INP | ~400ms | <200ms | Needs improvement |
| CLS | ~0.05 | <0.1 | ✅ Good |
| TBT | ~500ms | <150ms | Needs improvement |

## Accessibility Roadmap Phases

### Phase 1 (Sprint 1): Baseline
- [ ] Add focus-visible styles
- [ ] Verify color contrast (text and brand orange)
- [ ] Ensure keyboard focus indicators

### Phase 2 (Sprint 2-3): Enhanced
- [ ] Skip-to-content link
- [ ] ARIA labels on modals/buttons
- [ ] Focus trap in modals
- [ ] Landmark regions (<header>, <nav>, <main>, <aside>)

### Phase 3 (Sprint 4+): Advanced
- [ ] Screen reader testing (NVDA, VoiceOver, JAWS)
- [ ] Reduced motion support
- [ ] Form label association
- [ ] Table header scope

## UI Consistency Checklist

### Typography Scale (Inter-based)
- [ ] H1: 2.25rem (36px) 
- [ ] H2: 1.875rem (30px)
- [ ] H3: 1.5rem (24px)
- [ ] Body: 1rem (16px)
- [ ] Caption: 0.875rem (14px)

### Button Patterns
- [ ] Primary: --color-brand-500 bg, white text, --color-brand-600 hover
- [ ] Secondary: transparent bg, --color-primary border, --color-primary hover
- [ ] Focus-visible: 2px solid var(--color-primary) on all buttons
- [ ] Disabled: muted text, cursor: not-allowed

### Card Patterns
- [ ] card-soft: --shadow-soft, --radius-brand-lg, --color-surface
- [ ] card-elev: --shadow-elevated, --radius-brand-lg, --color-surface

### Spacing (4px Grid)
- [ ] var(--space-1): 4px, var(--space-2): 8px, var(--space-4): 16px
- [ ] var(--space-6): 24px, var(--space-8): 32px, var(--space-12): 48px

### Theme Consistency
- [ ] Light/dark tokens defined for all color variables
- [ ] Theme toggle preserves state across navigations
- [ ] System preference respects prefers-color-scheme
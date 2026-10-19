# 9router UX Architecture Recommendations

**Priority**: High → Medium → Low
**Framework**: Based on web-performance-analysis.md and code review

---

## Performance Budget Recommendations

### Immediate Actions (This Sprint)
| # | Recommendation | Effort | Impact | File | Lines |
|---|---------------|--------|--------|------|-------|
| 1 | Add `focus-visible` styles to globals.css | 10 min | +AA compliance, 0ms performance impact | `src/app/globals.css` | After line 366 |
| 2 | Reduce Material Symbols font loading timeout from 1s to 500ms | 5 min | +200ms FCP | `src/app/layout.js` | Line 49 |
| 3 | Add preload link for Inter font weights in layout.js head | 5 min | +100-200ms LCP reduction | `src/app/layout.js` | After line 51 |
| 4 | Verify Tailwind v4 content configuration | 30 min | -50-100KB CSS | New: `tailwind.config.mjs` | — |

### Short-Term (Next 2 Sprints)
| # | Recommendation | Effort | Impact | File |
|---|---------------|--------|--------|------|
| 5 | Defer Google Analytics initialization until user interaction | 20 min | +100-300ms FCP | `src/app/layout.js` |
| 6 | Set `images.unoptimized` to false or add `loading="lazy"` + fill props | 20 min | Prevents large LCP candidates | `next.config.mjs` line 35 |
| 7 | Split Monaco Editor loading with on-demand import | 1-2 hrs | -300-500KB initial bundle | `src/shared/components/MonacoEditor.js` |

### Long-Term (Next Release Cycle)
| # | Recommendation | Effort | Impact |
|---|---------------|--------|--------|
| 8 | Convert non-interactive client components to server components | 1-2 days | Improves TTI, reduces bundle size |
| 9 | Implement responsive images with Next.js `next/image` component | 1 day | Prevents LCP from unoptimized images |
| 10 | Add `sri` hashes to external scripts | 30 min | Security hardening, no perf tradeoff |

---

## Accessibility Compliance Roadmap

### Phase 1: WCAG 2.1 AA Baseline (Sprint 1)
| Check | Current Status | Action | Verification |
|-------|---------------|--------|-------------|
| Focus-visible indicators | ❌ Missing | Add `button:focus-visible { outline: 2px solid var(--color-primary); }` to globals.css | Tab through buttons; ring appears |
| Color contrast - text | ⚠️ Verify | Check #0A0A0A vs #FDFAF6 ratio ≥ 4.5:1 | Use color contrast checker |
| Color contrast - brand orange on white | ⚠️ Verify | Check #FFFFFF vs #E56A4A ratio ≥ 3:1 (large) or 4.5:1 (normal) | Use color contrast checker |
| ARIA labels on modals/buttons | ⚠️ Unknown | Add descriptive `aria-label` props | Screen reader test |
| Skip links | ❌ Missing | Add `<a href="#main-content">Skip to content</a>` | Keyboard navigation |
| Landmark regions | ⚠️ Partial | Add `<header>`, `<nav>`, `<main>`, `<aside>` elements | HTML structure review |

### Phase 2: Enhanced Compliance (Sprint 2-3)
| Check | Action | Priority |
|-------|--------|----------|
| Focus trap in modal dialogs | Implement ARIA `role="dialog"` + `aria-modal="true"` + focus management | High |
| Reduced motion support | Respect `prefers-reduced-motion` media query | Medium |
| Form label association | Ensure all form inputs have `<label>` or `aria-label` | High |
| Table header scope | Add `scope="col"`/`scope="row"` to table headers | Medium |
| Link purpose | Ensure link text is descriptive (not "click here") | High |

### Phase 3: Advanced (Sprint 4+)
| Check | Action |
|-------|--------|
| Screen reader testing | Test with NVDA (Windows), VoiceOver (Mac), JAWS |
| Keyboard navigation coverage | Tab order: logical, consistent, skip-able |
| Contrast for low-vision | Test with simulated vision impairments |
| Color dependence | Ensure information not conveyed by color alone |
| Dynamic content announcements | ARIA live regions for modal updates, form validation |

### Color Contrast Verification Priority
```
1. Body text: #0A0A0A on #FDFAF6 
   - Expected ratio: ~8.5:1 ✅ (likely passes AA)
   
2. Brand orange #E56A4A on white #FFFFFF
   - Expected ratio: ~3.1:1 ⚠️ (fails normal text AA, passes large text AA)
   - Action: Either darken text or lighten background for normal text
   
3. Brand orange #E56A4A on brand-50 #FDF1ED
   - Expected ratio: ~3.3:1 ⚠️ (similar to above)
   
4. Text-muted #6B7280 on #FDFAF6
   - Expected ratio: ~4.5:1 ✅ (likely passes AA for normal text)
```

---

## UI Consistency Improvements

### Typography Scale Establishment
Create consistent modular scale based on Inter font (16px base):

| Scale | CSS Variable | Rem | Px | Usage |
|-------|-------------|-----|-----|-------|
| H1 | — | 2.25rem | 36px | Page titles, section headers |
| H2 | — | 1.875rem | 30px | Section headings |
| H3 | — | 1.5rem | 24px | Subsection headings |
| Body | — | 1rem | 16px | Base paragraph text |
| Sm | — | 0.875rem | 14px | Caption, meta text |
| Xs | — | 0.75rem | 12px | Inline, small print |

**Implementation**: Add to `src/app/globals.css` or component-specific CSS:
```css
/* Typographic scale using clamp for responsive shrinkage */
.h1 { font-size: clamp(1.875rem, 4.5vw, 2.25rem); }
.h2 { font-size: clamp(1.5rem, 3vw, 1.875rem); }
.h3 { font-size: clamp(1.25rem, 2.5vw, 1.5rem); }
.body { font-size: 1rem; }
.caption { font-size: 0.875rem; }
```

### Button Visual Pattern Standardization
```
Primary Button Pattern:
- Background: var(--color-brand-500) #E56A4A
- Color: var(--color-bg) #FDFAF6 (white)
- Hover: var(--color-brand-600) #CC5236
- Focus-visible: outline: 2px solid var(--color-primary) [per ADR]
- Focus-visible bg: rgba(var(--color-primary-rgb), 0.15)
- Disabled: var(--color-text-muted) + cursor: not-allowed
- Radius: var(--radius-brand-lg) 14px
- Padding: var(--space-4) vertical, var(--space-6) horizontal

Secondary Button Pattern:
- Background: transparent
- Color: var(--color-primary) #E56A4A
- Border: 1px solid var(--color-primary)
- Hover: var(--color-bg-alt) #F7F3EE
- Focus-visible: same as primary
```

### Component Card Standardization
```
Card-Soft Pattern (subtle elevation):
- Background: var(--color-surface) #fff
- Box-shadow: var(--shadow-soft) 0 1px 2px 0 rgba(0,0,0,0.04)
- Border-radius: var(--radius-brand-lg) 14px
- Padding: var(--space-6) minimum

Card-Elev Pattern (prominent elevation):
- Background: var(--color-surface) #fff
- Box-shadow: var(--shadow-elevated) 0 12px 28px -4px rgba(60,50,45,0.06)
- Border-radius: var(--radius-brand-lg) 14px
- Padding: var(--space-8) minimum
```

### Spacing & Vertical Rhythm
```
4px Grid System:
- var(--space-1): 4px - micro spacing
- var(--space-2): 8px - small gap
- var(--space-4): 16px - standard spacing
- var(--space-6): 24px - section spacing
- var(--space-8): 32px - large gap
- var(--space-12): 48px - section divider
- var(--space-16): 64px - page margin

Implementation: Use Tailwind utilities consistently:
- `space-y-2` = 8px gap between children
- `space-y-4` = 16px gap between children  
- `py-4` = 16px vertical padding
- `px-6` = 24px horizontal padding
- `mx-auto` = centered container with max-width
```

### Theme Consistency Verification
```
Test Checklist:
1. [ ] Light theme loads default colors correctly
2. [ ] Dark theme (.dark class) applies all --color-* dark variants
3. [ ] Theme toggle persists across page navigations
4. [ ] System preference respects `prefers-color-scheme` media query
5. [ ] No FOUC (flash of unstyled content) during theme switch
6. [ ] All colors have both light and dark mode definitions
7. [ ] Brand orange #E56A4A used consistently as --color-brand-500
```

### Material Symbols Consistency
```
Font Size Scale:
- 20px: Small icons (inline with small text)
- 24px: Default (base size, used in globals.css line 336)
- 36px: Large icons (section headers, hero)
- 48px: Extra large (hero, prominent UI)

Usage Pattern:
- `<span className="material-symbols-outlined">cast</span>` = 24px default
- `<span className="material-symbols-outlined fill-1">cast</span>` = filled variant
- Size control: `className="material-symbols-outlined text-2xl"` 
  (Tailwind text-size utilities applied via font-size override)
```

---

## Implementation Priority Matrix

| Recommendation | Performance | Accessibility | UI Consistency | Effort | Order |
|---------------|-------------|---------------|----------------|--------|-------|
| focus-visible styles | ✅ 0ms impact | ⭐⭐⭐ Critical | ⭐⭐ Important | 10 min | 1 |
| reduce font timeout | ⭐⭐ +200ms FCP | — | — | 5 min | 2 |
| preconnect + preload fonts | ⭐⭐⭐ +100-200ms LCP | — | — | 5 min | 3 |
| Tailwind purge verification | ⭐⭐ -50-100KB CSS | — | — | 30 min | 4 |
| defer GA initialization | ⭐⭐ +100-300ms FCP | ⭐⭐ Privacy | — | 20 min | 5 |
| color contrast verification | — | ⭐⭐⭐ Critical | — | 30 min | 5 |
| focus trap in modals | — | ⭐⭐⭐ Critical | — | 1 hr | 6 |
| typography scale | — | — | ⭐⭐⭐ Important | 1 hr | 7 |
| button pattern standardization | — | — | ⭐⭐⭐ Important | 2 hrs | 8 |
| card pattern standardization | — | — | ⭐⭐ Important | 1 hr | 8 |
| spacing/vertical rhythm | — | — | ⭐⭐⭐ Important | 1 hr | 8 |
| theme consistency test | — | — | ⭐⭐ Important | 30 min | 9 |
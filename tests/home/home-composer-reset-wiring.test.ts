import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

/**
 * Every control that returns the user to the home page has to run the same
 * reset.
 *
 * This is a source test on purpose. The bug it exists to prevent was not a
 * wrong reset — it was *one* entry point out of seven quietly missing it, which
 * is invisible from any single button's behaviour and cannot be caught by
 * testing one route. Reading the files is the only check that covers the set:
 * a new "back to home" added without the call fails here, and so does an
 * existing one that loses it.
 */
describe('back-to-home wiring', () => {
  it.each([
    'components/stage/scene-sidebar.tsx',
    'components/edit/SlideNavRail/SlideNavRail.tsx',
    'components/header.tsx',
    'components/edit/EditShell/CommandBar.tsx',
    'app/generation-preview/page.tsx',
    'components/classroom/ClassroomSurface.tsx',
    'app/page.tsx',
  ])('%s runs the shared composer reset', (path) => {
    expect(source(path)).toContain('resetHomeComposer');
  });

  it.each(['components/header.tsx', 'components/edit/EditShell/CommandBar.tsx'])(
    '%s resets only when the exit resolves to the home page',
    (path) => {
      const text = source(path);
      // A workbench-attached classroom exits to `/workspace`, which has no
      // composer of its own. Resetting there would clear a prompt the user
      // never left.
      expect(text).toContain("resolveClassroomExit({ searchParams }).href === '/'");
    },
  );

  describe('the generation preview keeps its two other exits intact', () => {
    const text = () => source('app/generation-preview/page.tsx');

    it('routes the buttons labeled "back to home" through the resetting handler', () => {
      expect(text()).toContain('const leaveToHome = () => {');
      expect(text()).toContain('resetHomeComposer();');
      // The session-not-found card, the outline-review header, and the
      // generating header are the three controls labeled "back to home".
      expect(text().match(/onClick=\{leaveToHome\}/g) ?? []).toHaveLength(3);
    });

    it('leaves "back to requirements" alone — that prompt is the point of it', () => {
      // `OutlinesEditor`'s back is labeled "back to requirements" and exists so
      // the typed prompt survives; the draft cache is wiped only once the
      // outline is confirmed. Routing it through the reset would empty the box
      // the button promises to bring the user back to.
      expect(text()).toContain('onBack={goBackToHome}');
      expect(text()).not.toContain('onBack={leaveToHome}');
    });

    it('leaves "go back and retry" alone — it resumes the request that failed', () => {
      const retry = text().match(/onClick=\{goBackToHome\}[\s\S]{0,80}?generation\.goBackAndRetry/);
      expect(retry, 'the retry button must keep the non-resetting handler').not.toBeNull();
    });
  });

  it('the home page resets when a folder is left, and only then', () => {
    const text = source('app/page.tsx');
    // The breadcrumb leaves the folder and resets with it…
    expect(text).toMatch(/resetHomeComposer\(\);\s*setCurrentFolderId\(undefined\);/);
    // …and the search breadcrumb guards on being inside one, so the root view's
    // own disclosure toggle — which changes no route and unmounts nothing —
    // never costs the user their prompt.
    expect(text).toMatch(/if \(currentFolderId\) resetHomeComposer\(\);/);
  });

  it('gives the folder exit its own control instead of a mode of the disclosure', () => {
    const text = source('app/page.tsx');
    // The labelled back button exists only inside a folder, next to the
    // disclosure rather than inside it.
    expect(text).toContain('data-home-back-button=""');
    expect(text).toMatch(/\{currentFolderId && \(/);
    // …and the "recent" toggle no longer branches on where the user stands.
    // That branch — `if (currentFolderId) reset, else toggle` — is what made a
    // single control mean "go home" in one place and "collapse" in another, so
    // its return is a regression even while every gesture still works.
    expect(text).not.toContain('if (currentFolderId) {');
  });
});

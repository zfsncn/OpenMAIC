import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const json = (path: string) => JSON.parse(source(path)) as Record<string, unknown>;

/** Comments explain *why* the card avoids `fixed`; only code can use it. */
const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const GUIDE = 'components/classroom/home-usage-guide.tsx';
const PAGE = 'app/page.tsx';

const LOCALES = [
  'ar-SA',
  'de-DE',
  'en-US',
  'es-MX',
  'fr-FR',
  'ja-JP',
  'ko-KR',
  'pt-BR',
  'ru-RU',
  'vi-VN',
  'zh-CN',
  'zh-TW',
];

/** Every leaf the card and the dialog can ask for, in full. */
const GUIDE_KEYS = [
  'title',
  'openLabel',
  'collapseLabel',
  'expandLabel',
  'apiKeyNote',
  'steps.noText.title',
  'steps.noText.desc',
  'steps.withMaterial.title',
  'steps.withMaterial.desc',
  'steps.existing.title',
  'steps.existing.desc',
];

type GuideCopy = {
  title: string;
  openLabel: string;
  collapseLabel: string;
  expandLabel: string;
  apiKeyNote: string;
  steps: Record<'noText' | 'withMaterial' | 'existing', { title: string; desc: string }>;
};

type Bundle = {
  home: { usageGuide: GuideCopy };
  toolbar: { enterClassroom: string };
  classroom: { newFolderTitle: string };
};

const bundle = (locale: string) => json(`lib/i18n/locales/${locale}.json`) as unknown as Bundle;

function leafKeys(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

/**
 * A source test, on purpose. The two ways this card can go wrong are both
 * invisible from any single render:
 *
 *  - It can be positioned so it *looks* right on a 1514px window and lands on
 *    top of the composer on a 1366px laptop. That is a statement about a
 *    breakpoint, which only exists in the class list.
 *  - Its copy lives in twelve files, and a missing key renders as a raw key
 *    string in exactly one language, which nobody exercising the app in zh-CN
 *    will ever see.
 *
 * Reading the files covers both.
 */
describe('home usage guide', () => {
  const guide = () => stripComments(source(GUIDE));

  it('is mounted from the home page, and only there', () => {
    const text = source(PAGE);
    expect(text).toContain('HomeUsageGuide');
    // The card anchors to the band of empty space right of the centred hero, so
    // the page frame has to be its positioning context.
    expect(text).toMatch(/relative min-h-\[100dvh\]/);
    // The pro-swap handoff carries the hero into the workbench; replaying the
    // entrance animation after it would fight the route transition.
    expect(text).toContain('skipEnter={swapped}');
  });

  describe('positioning', () => {
    it('is absolute, never fixed', () => {
      // `fixed` would hold the card in place while the page scrolled and park it
      // on top of the "recent classrooms" thumbnails below the hero.
      expect(guide()).toContain("'absolute end-8 top-[calc(4rem+10vh)] z-20'");
      expect(guide()).not.toMatch(/\bfixed\b/);
    });

    it('gates the card on a 1440px breakpoint and hides the fallback there', () => {
      const text = guide();
      // The hero is centred, so the card only fits while `w <= W/2 - 448`. Below
      // 1440 it would overlap the composer, so the card is display:none and the
      // "?" entry takes over.
      expect(text).toContain('hidden min-[1440px]:flex');
      expect(text).toContain('min-[1440px]:hidden');
    });

    it('caps its width so it can never reach the composer', () => {
      // `50vw - 464px` is deliberately more conservative than the `W/2 - 448`
      // bound, because `vw` counts the scrollbar that the layout viewport does
      // not. `min()` then holds a comfortable 280px on wide screens.
      expect(guide()).toContain('w-[min(280px,calc(50vw-464px))]');
    });

    it('caps its height at the gap between the hero and the thumbnails', () => {
      // 500px is the measured distance; past it the card would overlap the
      // thumbnails, which really do share its horizontal band.
      const text = guide();
      expect(text).toContain('max-h-[500px]');
      expect(text).toContain('overflow-y-auto');
    });
  });

  describe('collapse behaviour', () => {
    it('remembers the collapsed state under its own storage key', () => {
      const text = guide();
      expect(text).toContain("export const USAGE_GUIDE_OPEN_STORAGE_KEY = 'homeUsageGuideOpen'");
      expect(text).toContain('localStorage.getItem(USAGE_GUIDE_OPEN_STORAGE_KEY)');
      expect(text).toContain('localStorage.setItem(USAGE_GUIDE_OPEN_STORAGE_KEY, String(next))');
      // Only an explicit "false" collapses it, so a fresh user — and a user
      // whose storage is blocked — starts with the guide open.
      expect(text).toContain("!== 'false'");
    });

    it('exposes the toggle with its expanded state', () => {
      const text = guide();
      expect(text).toContain('data-home-usage-guide-toggle=""');
      expect(text).toContain('aria-expanded={open}');
      expect(text).toMatch(/\{open && \(/);
    });
  });

  it('renders one body for both surfaces, so they cannot drift', () => {
    const text = guide();
    // Exactly one definition…
    expect(text.match(/function UsageGuideBody\(/g) ?? []).toHaveLength(1);
    // …consumed by the wide card and the narrow dialog.
    expect(text.match(/<UsageGuideBody /g) ?? []).toHaveLength(2);
    expect(text).toContain('variant="card"');
    expect(text).toContain('variant="dialog"');
  });

  it('gives the fallback a stable hook and an accessible name', () => {
    const text = guide();
    expect(text).toContain('data-home-usage-guide-entry=""');
    expect(text).toContain("aria-label={t('home.usageGuide.openLabel')}");
    expect(text).toContain('data-home-usage-guide=""');
  });

  describe('copy', () => {
    it('asks for exactly the keys that exist, in every locale', () => {
      const text = guide();
      for (const key of GUIDE_KEYS.filter((k) => !k.startsWith('steps.'))) {
        expect(text, `missing t('home.usageGuide.${key}')`).toContain(`home.usageGuide.${key}`);
      }

      const steps = [...text.matchAll(/\bid: '([a-zA-Z]+)'/g)].map((m) => m[1]);
      expect(steps).toEqual(['noText', 'withMaterial', 'existing']);

      const expected = GUIDE_KEYS.slice().sort();
      for (const locale of LOCALES) {
        expect(leafKeys(bundle(locale).home.usageGuide).sort(), `${locale} key mismatch`).toEqual(
          expected,
        );
      }
    });

    it('quotes the real button labels instead of paraphrasing them', () => {
      // The guide names two controls; each locale's copy has to use that
      // locale's own label for them, or it points at a button that is not there.
      for (const locale of LOCALES) {
        const { home, toolbar, classroom } = bundle(locale);
        const { noText, withMaterial, existing } = home.usageGuide.steps;

        expect(noText.desc, `${locale} does not name "${toolbar.enterClassroom}"`).toContain(
          toolbar.enterClassroom,
        );
        expect(
          withMaterial.desc,
          `${locale} does not name "${classroom.newFolderTitle}"`,
        ).toContain(classroom.newFolderTitle);
        // Step 3 opens an existing folder rather than creating one.
        expect(existing.desc, `${locale} should not offer to create a folder`).not.toContain(
          classroom.newFolderTitle,
        );
      }
    });

    it('warns that a first visit can show no folders yet', () => {
      // The folder list is hydrated client-side, so the first paint can be
      // empty. Step 3 has to say so, otherwise the instruction reads as broken
      // — and it has to name a folder that actually exists in the deployment.
      const { existing } = bundle('zh-CN').home.usageGuide.steps;
      expect(existing.desc).toContain('刷新浏览器');
      expect(existing.desc).toContain('舆情学');
    });

    it('tells users where to go when the hosted key fails', () => {
      // The server hosts the credentials, so a user cannot fix a failure by
      // uploading their own file — the note has to point at the settings entry.
      const note = bundle('zh-CN').home.usageGuide.apiKeyNote;
      expect(note).toContain('LLM API Key');
      expect(note).toContain('右上角');
    });
  });
});

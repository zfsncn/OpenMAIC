import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

/**
 * A course generated from inside a folder has to land in that folder.
 *
 * This is a source test on purpose, and for the same reason as the
 * back-to-home wiring test next door: the invariants that matter here are not
 * observable from one button's behaviour. They are *ordering* (the filing
 * UPDATE needs the stage row the save INSERTs), *conditionality* (a root-view
 * session must not carry the field at all), and *scope* (the extraction-only
 * session must never carry it). Each is a property of the source, and each has
 * a silent failure mode that the UI looks fine through.
 */
describe('generated-course folder filing', () => {
  describe('the home page captures the folder at click time', () => {
    const text = () => source('app/page.tsx');

    it('freezes the folder alongside the material snapshot', () => {
      // Same reason the materials are frozen: the preview page navigates the
      // user away, so whatever folder is active when generation resolves is not
      // necessarily the one they generated from.
      expect(text()).toContain('const frozenFolderId = currentFolderId;');
    });

    it('carries it into the generation session only when a folder is on screen', () => {
      // A conditional spread, not a plain field: a root-view session must keep
      // the exact shape it had before this field existed, and the *absent key*
      // is what tells the preview page not to file. Writing
      // `targetFolderId: frozenFolderId` unconditionally would still serialise
      // away (JSON.stringify drops undefined), but the spread states the
      // intent and keeps the key out of the type's required surface.
      expect(text()).toContain('...(frozenFolderId ? { targetFolderId: frozenFolderId } : {})');
    });

    it('never puts it on the extraction-only session', () => {
      // That path runs extraction and opens an existing classroom — there is no
      // new stage to file, so a folder id there would be dead data. Slice the
      // object literal out and prove the key is not in it.
      const t = text();
      const start = t.indexOf('const extractOnlySession');
      const end = t.indexOf('satisfies GenerationSessionState', start);
      expect(start, 'the extract-only session literal must exist').toBeGreaterThan(-1);
      expect(end, 'it must end in a satisfies clause').toBeGreaterThan(start);
      expect(t.slice(start, end)).not.toContain('targetFolderId');
    });
  });

  describe('the preview page files after the row exists', () => {
    const text = () => source('app/generation-preview/page.tsx');

    it('files only when the save verified and a folder was carried', () => {
      // The save's boolean matters: `false` means the write was dropped (stale
      // epoch) and nothing was persisted, so the filing UPDATE would 404 too.
      expect(text()).toContain('if (saved && currentSession.targetFolderId) {');
    });

    it('files strictly after saveToStorage — the stage row is INSERTed inside it', () => {
      // `setStageFolder` is an UPDATE with an EXISTS guard: it matches zero rows
      // and answers 404 FOLDER_NOT_FOUND until the stage row exists, and that
      // row is written by `saveToStorage`. Source order is the invariant.
      const t = text();
      const save = t.indexOf('const saved = await store.saveToStorage();');
      const file = t.indexOf('await setStageFolder(stage.id, currentSession.targetFolderId);');
      expect(save, 'the save call must exist').toBeGreaterThan(-1);
      expect(file, 'the filing call must exist').toBeGreaterThan(-1);
      expect(file, 'filing must come after the save').toBeGreaterThan(save);
    });

    it('treats filing as best-effort — a failure still opens the classroom', () => {
      // A folder deleted in another tab must not cost the user their course.
      // The failure degrades to the root view, i.e. the pre-feature behaviour.
      const t = text();
      const start = t.indexOf('if (saved && currentSession.targetFolderId) {');
      const branch = t.slice(start, t.indexOf('router.push(`/classroom/${stage.id}`)', start));
      expect(branch).toContain('catch (err)');
      expect(branch).toContain("toast.error(t('classroom.moveFailed'))");
    });
  });

  describe('the home page files a reused classroom that has no folder yet', () => {
    const text = () => source('app/page.tsx');

    it('files it only when a folder is on screen and it is not filed yet', () => {
      // Reuse is the one path that used to leave a course unfiled: the user
      // generated from inside a folder, but the classroom that answered was
      // created earlier, before folders existed. A classroom already filed
      // somewhere stays put — moving it would take it out of where it was
      // deliberately put.
      expect(text()).toContain('if (frozenFolderId && !existingClassroom.folderId) {');
    });

    it('files it with the click-time folder, before navigating away to it', () => {
      // Same frozen snapshot as the create path, and before the navigation:
      // this page unmounts on push, so a filing that started after it would
      // never be awaited.
      const t = text();
      const start = t.indexOf('if (frozenFolderId && !existingClassroom.folderId) {');
      const navigate = t.indexOf('router.push(`/classroom/${existingClassroom.id}`)', start);
      expect(start, 'the conditional filing branch must exist').toBeGreaterThan(-1);
      expect(navigate, 'the reuse branch must navigate').toBeGreaterThan(start);
      expect(t.slice(start, navigate)).toContain(
        'await setStageFolder(existingClassroom.id, frozenFolderId);',
      );
    });

    it('treats filing as best-effort — a failure still opens the classroom', () => {
      // A folder deleted in another tab must not cost the user their lesson.
      const t = text();
      const start = t.indexOf('if (frozenFolderId && !existingClassroom.folderId) {');
      const navigate = t.indexOf('router.push(`/classroom/${existingClassroom.id}`)', start);
      const branch = t.slice(start, navigate);
      expect(branch).toContain('catch (err)');
      expect(branch).toContain("toast.error(t('classroom.moveFailed'))");
    });
  });

  it('keeps the session field optional so old sessions are unaffected', () => {
    // Read as `JSON.parse(...) as GenerationSessionState` with no whitelist, so
    // an absent key is simply `undefined` — the guard in the preview page then
    // skips filing, which is exactly the old behaviour.
    expect(source('app/generation-preview/types.ts')).toContain('targetFolderId?: string;');
  });
});

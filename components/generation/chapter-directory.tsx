'use client';

import { useState, useSyncExternalStore } from 'react';
import { ChevronUp, FileText, AlertTriangle, X, ListChecks, GraduationCap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { isCourseMaterialUsable } from '@/lib/document/course-material-availability';
import { chapterDisplayName } from '@/lib/utils/chapter-naming';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { SelectedCourseMaterial } from '@/lib/types/generation';

const NARROW_VIEWPORT_QUERY = '(max-width: 767px)';

/** The display-name rule lives in `@/lib/utils/chapter-naming` — shared with the
 * requirement the composer is pre-filled with when a chapter is selected. */

function subscribeNarrowViewport(onStoreChange: () => void) {
  const query = window.matchMedia(NARROW_VIEWPORT_QUERY);
  query.addEventListener('change', onStoreChange);
  return () => query.removeEventListener('change', onStoreChange);
}

function getNarrowViewportSnapshot() {
  return window.matchMedia(NARROW_VIEWPORT_QUERY).matches;
}

function getNarrowViewportServerSnapshot() {
  return false;
}

export interface ChapterDirectoryProps {
  /** The chapters of the folder on screen, in attachment order. */
  courseMaterials: SelectedCourseMaterial[];
  /**
   * Name of the folder these chapters are filed under, or `undefined` in the
   * root view. Shown as the panel's title, so the panel says which folder it is
   * describing, and — with no chapters — it is what makes the empty panel worth
   * rendering at all.
   */
  folderName?: string;
  /**
   * Currently selected chapter (a `SelectedCourseMaterial.id`), or null when
   * none is selected — in which case every material is merged, which is the
   * pre-existing behaviour. Selection is an optional refinement, never a
   * validation gate: a null value must stay valid.
   */
  selectedMaterialId: string | null;
  /**
   * Toggle the chapter selection. `null` clears the selection, so clicking the
   * selected row again returns to the merge-everything path.
   */
  onSelectMaterial: (id: string | null) => void;
  onCourseMaterialRemove: (id: string) => void;
  /**
   * While the parent is preparing a generation session the chapter set is
   * frozen, so every mutating affordance here is inert.
   */
  materialsLocked?: boolean;
  /**
   * Build a unit-quiz classroom from the selected chapter. The action needs a
   * chosen chapter (a quiz is scoped to one chapter, never to the merged set),
   * so the button stays disabled until exactly one is selected. Clicking it
   * runs the generation straight away — it is an action, not a mode switch.
   */
  onUnitQuiz: () => void;
  /**
   * Build a case-teaching classroom from the selected chapter. Like the
   * unit-quiz action it is scoped to one chapter and runs immediately on
   * click, so it is gated on the same condition: a selected chapter whose
   * bytes — or archived extraction — are still resolvable.
   */
  onCaseTeaching: () => void;
}

/**
 * Fixed top-left chapter directory: the attached materials listed in order as
 * 第一章 / 第二章 / … , each row selectable so a lesson can be generated from a
 * single chapter.
 *
 * The list lives here rather than in the toolbar's material popover so the
 * chapters are visible without opening anything, and so the upload popover
 * stays a pure "add a file" surface. Selection state itself is owned by the
 * homepage and passed down — this component never stores it, so the two
 * surfaces cannot disagree.
 *
 * Which chapters these are is the homepage's decision, not this component's:
 * folders keep separate chapter lists, and the homepage hands down the one the
 * active folder owns. All this component needs to know is whether it is
 * describing a folder (`folderName`) or the root.
 */
export function ChapterDirectory({
  courseMaterials,
  folderName,
  selectedMaterialId,
  onSelectMaterial,
  onCourseMaterialRemove,
  materialsLocked = false,
  onUnitQuiz,
  onCaseTeaching,
}: ChapterDirectoryProps) {
  const { t } = useI18n();

  // The directory is a corner overlay, so on a phone-width viewport it would
  // cover most of the hero: default to collapsed there. The breakpoint is read
  // as an external subscription (so the server render and the first client
  // render agree on `false` instead of diverging mid-hydration) rather than
  // written into state from an effect; once the user toggles it, that wins.
  const isNarrowViewport = useSyncExternalStore(
    subscribeNarrowViewport,
    getNarrowViewportSnapshot,
    getNarrowViewportServerSnapshot,
  );
  const [collapsedOverride, setCollapsedOverride] = useState<boolean | null>(null);
  const collapsed = collapsedOverride ?? isNarrowViewport;

  // Which chapter the confirmation dialog is asking about. Kept as an id and
  // re-resolved against the live list below, so a material removed by someone
  // else while the dialog is open — the toolbar drops files the active
  // extractor cannot read — closes the dialog instead of confirming a removal
  // that already happened.
  const [pendingRemovalId, setPendingRemovalId] = useState<string | null>(null);

  // Chapters render in attachment order. Sorting mirrors the toolbar's list, so
  // a material whose `order` was rewritten (after a removal) still lines up
  // with the numbering every other surface shows.
  const chapters = [...courseMaterials].sort((a, b) => a.order - b.order);
  const selectedChapter = selectedMaterialId
    ? (chapters.find((chapter) => chapter.id === selectedMaterialId) ?? null)
    : null;
  const pendingRemoval = pendingRemovalId
    ? (chapters.find((chapter) => chapter.id === pendingRemovalId) ?? null)
    : null;

  // Nothing to show. In the root view that means the pristine homepage has no
  // chapters attached, so stay out of the way entirely. Inside a folder it means
  // the folder is empty — a state the user navigated into on purpose, and one
  // that has to be visible: an empty folder that renders nothing looks exactly
  // like a panel that failed to load, and gives no hint that uploading here is
  // what fills it.
  const isEmpty = chapters.length === 0;
  if (isEmpty && !folderName) return null;

  // A quiz is scoped to one chapter, so the action needs a selected — and
  // still resolvable — chapter. A selection whose bytes are gone is not enough:
  // that path would fail at extraction. A case lesson is scoped the same way,
  // so it shares the predicate rather than restating it.
  const canUnitQuiz =
    !materialsLocked && selectedChapter !== null && isCourseMaterialUsable(selectedChapter);
  const canCaseTeaching = canUnitQuiz;

  return (
    <div
      data-chapter-directory=""
      className={cn(
        'fixed top-4 start-4 z-40 flex w-[264px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden border shadow-sm backdrop-blur-md transition-all',
        'border-gray-100/50 bg-white/70 dark:border-gray-700/50 dark:bg-gray-800/70',
        collapsed ? 'rounded-full' : 'rounded-xl',
      )}
    >
      <div className="flex shrink-0 items-center gap-1.5 px-3 py-2">
        <FileText className="size-3.5 shrink-0 text-violet-600 dark:text-violet-400" />
        <span
          className="min-w-0 flex-1 truncate text-xs font-medium text-gray-700 dark:text-gray-200"
          title={folderName}
        >
          {selectedChapter
            ? t('toolbar.selectedChapterBadge', { n: selectedChapter.order })
            : (folderName ?? t('toolbar.chapterDirectory'))}
        </span>
        <span className="shrink-0 rounded-full bg-black/5 px-1.5 text-[10px] tabular-nums text-gray-500 dark:bg-white/10 dark:text-gray-400">
          {chapters.length}
        </span>
        <button
          type="button"
          onClick={() => setCollapsedOverride(!collapsed)}
          aria-expanded={!collapsed}
          aria-controls="chapter-directory-list"
          aria-label={
            collapsed ? t('toolbar.chapterDirectoryExpand') : t('toolbar.chapterDirectoryCollapse')
          }
          className="size-5 shrink-0 cursor-pointer rounded-full text-gray-400 transition-colors hover:bg-black/5 hover:text-gray-700 dark:hover:bg-white/10 dark:hover:text-gray-200"
        >
          <ChevronUp
            className={cn('mx-auto size-3.5 transition-transform', collapsed && 'rotate-180')}
          />
        </button>
      </div>

      {!collapsed && (
        <>
          {isEmpty && (
            <div data-chapter-directory-empty="" className="px-3 pt-1 pb-2">
              <p className="text-[11px] text-gray-600 dark:text-gray-300">
                {t('toolbar.chapterDirectoryEmpty')}
              </p>
              <p className="pt-1 text-[10px] leading-relaxed text-gray-400 dark:text-gray-500">
                {t('toolbar.chapterDirectoryEmptyHint')}
              </p>
            </div>
          )}

          {/* Single-choice axis: a lesson is built from one chapter, and
              "none selected" stays the default so the merged-everything path
              is intact. */}
          <div
            id="chapter-directory-list"
            role="radiogroup"
            aria-label={folderName ?? t('toolbar.chapterDirectory')}
            className={cn(
              // Only the list scrolls: the header, the merge hint and the
              // action row stay pinned. A fixed-position panel cannot scroll
              // itself into view, so an unbounded list would put everything
              // below it out of reach on a short viewport.
              'max-h-[452px] overflow-y-auto overscroll-contain px-2 [scrollbar-gutter:stable]',
              isEmpty ? 'hidden' : 'space-y-1',
            )}
          >
            {chapters.map((chapter) => {
              const isSelected = selectedMaterialId === chapter.id;
              // A chapter restored from the synced directory on a device that
              // never held its bytes keeps its place in the list — that is the
              // whole point of the directory surviving a device change — and
              // stays selectable, because the extraction archived under its
              // digest is what the generation step falls back to. Only a
              // chapter with neither bytes nor a digest has nothing left to
              // resolve, and that one waits for the file to be picked again.
              // Removing any of them stays available; dropping the chapter is
              // a legitimate answer.
              const isAvailable = isCourseMaterialUsable(chapter);
              const selectable = !materialsLocked && isAvailable;
              return (
                <div
                  key={chapter.id}
                  className={cn(
                    'flex items-center gap-1.5 rounded-lg border px-2 py-1.5 transition-colors',
                    isSelected
                      ? 'border-violet-400/70 bg-violet-50/70 dark:border-violet-500/50 dark:bg-violet-950/20'
                      : 'border-transparent hover:border-gray-200 dark:hover:border-gray-700',
                  )}
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    aria-label={`${t('toolbar.selectChapter')} ${chapter.order}: ${chapterDisplayName(chapter.name)}`}
                    disabled={!selectable}
                    onClick={() => onSelectMaterial(isSelected ? null : chapter.id)}
                    className={cn(
                      'inline-flex size-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
                      selectable ? 'cursor-pointer' : 'cursor-not-allowed opacity-40',
                      isSelected
                        ? 'border-violet-500 dark:border-violet-400'
                        : 'border-gray-300 hover:border-violet-400 dark:border-gray-600',
                    )}
                  >
                    {isSelected && (
                      <span className="size-2 rounded-full bg-violet-500 dark:bg-violet-400" />
                    )}
                  </button>

                  {/* The ordinal lives in its own column so it reads as the
                      chapter's position in the set, not as part of the title. */}
                  <span
                    aria-hidden="true"
                    className="w-4 shrink-0 text-right text-[11px] font-medium tabular-nums text-gray-400 dark:text-gray-500"
                  >
                    {chapter.order}
                  </span>

                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-xs',
                      isAvailable
                        ? 'text-gray-700 dark:text-gray-200'
                        : 'text-gray-400 dark:text-gray-500',
                    )}
                    title={
                      isAvailable
                        ? chapter.name
                        : `${chapter.name} — ${t('toolbar.chapterFileMissing')}`
                    }
                  >
                    {chapterDisplayName(chapter.name)}
                  </span>

                  {!isAvailable && (
                    <span
                      data-chapter-missing=""
                      role="img"
                      aria-label={t('toolbar.chapterFileMissing')}
                      title={t('toolbar.chapterFileMissing')}
                      className="shrink-0 text-amber-500 dark:text-amber-400"
                    >
                      <AlertTriangle className="size-3" />
                    </span>
                  )}

                  <span className="shrink-0 text-[10px] tabular-nums text-gray-400 dark:text-gray-500">
                    {(chapter.size / 1024 / 1024).toFixed(2)} MB
                  </span>

                  <button
                    type="button"
                    onClick={() => setPendingRemovalId(chapter.id)}
                    disabled={materialsLocked}
                    aria-label={t('toolbar.removeCourseMaterial')}
                    className={cn(
                      'inline-flex size-5 shrink-0 items-center justify-center rounded-full text-gray-400 transition-colors',
                      materialsLocked
                        ? 'cursor-not-allowed opacity-40'
                        : 'cursor-pointer hover:bg-black/5 hover:text-gray-700 dark:hover:bg-white/10 dark:hover:text-gray-200',
                    )}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              );
            })}
          </div>

          <p
            className={cn(
              'shrink-0 px-3 pt-1 pb-2 text-[10px] leading-relaxed text-gray-400 dark:text-gray-500',
              isEmpty && 'hidden',
            )}
          >
            {t('toolbar.chapterMergeHint')}
          </p>

          {/* Actions sit outside the scroll area as the last flex sibling, so
              they stay pinned however long the chapter list grows. Both are
              click-to-run actions rather than a mode switch: each generates its
              own kind of classroom straight away, and each needs a selected
              chapter. They carry different accents because they produce
              different lessons from the same chapter — the colour is what tells
              them apart at a glance. */}
          <div className="flex shrink-0 gap-1.5 border-t border-gray-100/70 px-2 py-2 dark:border-gray-700/50">
            <button
              type="button"
              data-chapter-action="unit-quiz"
              onClick={onUnitQuiz}
              disabled={!canUnitQuiz}
              title={t('toolbar.unitQuiz')}
              className={cn(
                'inline-flex min-w-0 flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-medium transition-colors',
                canUnitQuiz
                  ? 'cursor-pointer bg-violet-600 text-white hover:bg-violet-700'
                  : 'cursor-not-allowed bg-black/5 text-gray-400 dark:bg-white/10 dark:text-gray-500',
              )}
            >
              <ListChecks className="size-3.5 shrink-0" />
              <span className="truncate">{t('toolbar.unitQuiz')}</span>
            </button>
            <button
              type="button"
              data-chapter-action="case-teaching"
              onClick={onCaseTeaching}
              disabled={!canCaseTeaching}
              title={t('toolbar.caseTeaching')}
              className={cn(
                'inline-flex min-w-0 flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-medium transition-colors',
                canCaseTeaching
                  ? 'cursor-pointer bg-teal-600 text-white hover:bg-teal-700'
                  : 'cursor-not-allowed bg-black/5 text-gray-400 dark:bg-white/10 dark:text-gray-500',
              )}
            >
              <GraduationCap className="size-3.5 shrink-0" />
              <span className="truncate">{t('toolbar.caseTeaching')}</span>
            </button>
          </div>
        </>
      )}

      {/* Removal is destructive and cannot be undone from the page — the bytes
          live in memory only, so a mistaken click costs a re-upload. Ask first.
          Only the click on this row's ✕ lands here: the toolbar's automatic
          cleanup of extractor-incompatible files calls the same parent handler
          and must stay silent (it can drop several files at once). */}
      <AlertDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemovalId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('toolbar.removeCourseMaterialConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('toolbar.removeCourseMaterialConfirmMessage', {
                name: pendingRemoval?.name ?? '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-xl">{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="rounded-xl"
              disabled={materialsLocked}
              onClick={() => {
                if (pendingRemoval) onCourseMaterialRemove(pendingRemoval.id);
              }}
            >
              {t('common.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

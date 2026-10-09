'use client';

import { useState, useEffect, useMemo, useRef, useDeferredValue } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'motion/react';
import {
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Folder,
  FolderPlus,
  ImagePlus,
  Pencil,
  Trash2,
  Search,
  Settings,
  Sun,
  Moon,
  Monitor,
  ChevronUp,
  Upload,
  Sparkles,
  Atom,
  X,
  Presentation,
  Loader2,
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { LanguageSwitcher } from '@/components/language-switcher';
import { createLogger } from '@/lib/logger';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupInput, InputGroupButton } from '@/components/ui/input-group';
import { Textarea as UITextarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { SettingsDialog } from '@/components/settings';
import { GenerationToolbar } from '@/components/generation/generation-toolbar';
import { ChapterDirectory } from '@/components/generation/chapter-directory';
import { HomeUsageGuide, HomeUsageGuideEntry } from '@/components/classroom/home-usage-guide';
import { AgentBar } from '@/components/agent/agent-bar';
import { useTheme } from '@/lib/hooks/use-theme';
import { nanoid } from 'nanoid';
import { deleteDocumentBlob, storeDocumentBlob } from '@/lib/utils/image-storage';
import { isCourseMaterialUsable } from '@/lib/document/course-material-availability';
import { computeContentDigest } from '@/lib/document/content-digest';
import { hasUsableArchivedExtraction } from '@/lib/document/extraction-archive-client';
import { normalizeDocumentMimeType } from '@/lib/document/mime';
import {
  courseMaterialFingerprint,
  courseMaterialsInView,
  dedupeCourseMaterialFiles,
} from '@/lib/document/course-materials';
import {
  readHomeMaterialsResult,
  restoreCourseMaterials,
  writeHomeMaterials,
} from '@/lib/document/course-material-persistence';
import type {
  SelectedCourseMaterial,
  SessionDocumentSource,
  UserRequirements,
} from '@/lib/types/generation';
// Type-only: the extract-only session written below has to match what the
// preview page reads back out of `sessionStorage`, so it is typed by the shape
// that page declares rather than by a second copy of it here. `import type` is
// erased, so the preview page's UI imports do not follow it into this bundle.
import type { GenerationSessionState } from './generation-preview/types';
import { useSettingsStore } from '@/lib/store/settings';
import { hasUsableLLMProvider } from '@/lib/store/settings-validation';
import { useUserProfileStore, AVATAR_OPTIONS } from '@/lib/store/user-profile';
import {
  StageListItem,
  listStages,
  deleteStageData,
  renameStage,
  getFirstSlideByStages,
  revokeThumbnailSlideMediaUrls,
  listFolders,
  createFolder,
  renameFolder,
  deleteFolder,
  setStageFolder,
  FolderNameError,
  LIBRARY_CHANGED_EVENT,
  type DeleteFolderMode,
} from '@/lib/utils/stage-storage';
import type { FolderRecord } from '@/lib/types/folder';
import { displayNameWidth, FOLDER_NAME_MAX_WIDTH } from '@/lib/utils/folder-name-validation';
import { resolveChapterTitle } from '@/lib/utils/chapter-naming';
import { isCourseware } from '@/lib/utils/courseware';
import { FolderCard } from '@/components/discovery/folder-card';
import { NewFolderDialog } from '@/components/discovery/folder-dialogs';
import { MoveToFolderMenu } from '@/components/discovery/move-to-folder-menu';
import { SlideThumbnail } from '@/components/slide-renderer/SlideThumbnail';
import type { Slide } from '@openmaic/dsl';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { toast } from 'sonner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDraftCache } from '@/lib/hooks/use-draft-cache';
import {
  COMPOSER_DRAFT_KEY,
  HOME_COMPOSER_RESET_EVENT,
  consumePendingHomeComposerReset,
  resetHomeComposer,
} from '@/lib/home/composer-reset';
import { SpeechButton } from '@/components/audio/speech-button';
import { useImportClassroom } from '@/lib/import/use-import-classroom';
import {
  isProWorkbenchEnabled,
  isPptxImportEnabled,
  shouldShowVocationalTestUi,
} from '@/lib/config/feature-flags';
import { useImportPptx } from '@/lib/import/use-import-pptx';
import { InteractiveModeButton } from '@/components/generation/interactive-mode-button';
import { ProBadge } from '@/components/workbench/ProBadge';
import { arrivedByProSwap, startProSwap } from '@/lib/workbench/pro-swap';
import {
  readLastWorkspaceSessionId,
  workspaceResumeHref,
} from '@/lib/workbench/workspace-session-memory';

const log = createLogger('Home');

const RECENT_OPEN_STORAGE_KEY = 'recentClassroomsOpen';
const INTERACTIVE_MODE_STORAGE_KEY = 'interactiveModeEnabled';

// PPTX import is still scaffolding: `useImportPptx` has no `onImported` consumer
// yet, so the flow only logs the parsed slides. Hide the entry point behind a
// flag until it's wired end-to-end, so the UI doesn't expose a no-op button.
const PPTX_IMPORT_ENABLED = isPptxImportEnabled();

/** The configured runtime probe result, retained across client navigations. */
let workbenchRuntimeCache: boolean | null = null;

interface FormState {
  /**
   * Every attached material, across every folder — one list, not one per
   * folder. Each row carries the `folderId` it is filed under, and the folder
   * on screen is applied as a filter over this (`visibleMaterials`); only the
   * restore, the write-back and the row-level mutators touch it whole.
   */
  courseMaterials: SelectedCourseMaterial[];
  /**
   * Chapter selection: the id of the single material a lesson should be built
   * from, or null to merge every material (the pre-existing behaviour). It is a
   * refinement, never a validation gate — a dangling id is tolerated and
   * resolved to null at read time (see `effectiveSelectedMaterialId`), and the
   * view narrows that further (see `visibleSelectedMaterialId`).
   */
  selectedMaterialId: string | null;
  requirement: string;
  interactiveMode: boolean;
  vocationalTestMode: boolean;
}

const initialFormState: FormState = {
  courseMaterials: [],
  selectedMaterialId: null,
  requirement: '',
  interactiveMode: false,
  vocationalTestMode: false,
};

function HomePage() {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  // Do not replay the classic hero's entrance after the route handoff already
  // carried the lockup and composer into place.
  const [swapped] = useState(arrivedByProSwap);
  const heroEnter = (from: Record<string, number>) => (swapped ? false : from);
  const showVocationalTestUi = shouldShowVocationalTestUi();
  const workbenchBuildEnabled = isProWorkbenchEnabled();
  const [workbenchRuntimeEnabled, setWorkbenchRuntimeEnabled] = useState(
    workbenchRuntimeCache === true,
  );
  useEffect(() => {
    if (!workbenchBuildEnabled || workbenchRuntimeCache !== null) return;
    let cancelled = false;
    fetch('/api/agent/runtime')
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        workbenchRuntimeCache = body?.enabled === true;
        if (!cancelled) setWorkbenchRuntimeEnabled(workbenchRuntimeCache);
      })
      .catch(() => {
        // A failed probe keeps the entry hidden and allows a later visit to retry.
      });
    return () => {
      cancelled = true;
    };
  }, [workbenchBuildEnabled]);
  const workbenchEntryEnabled = workbenchBuildEnabled && workbenchRuntimeEnabled;
  const enterWorkbench = () => {
    const href = workspaceResumeHref(readLastWorkspaceSessionId());
    startProSwap(href, (next) => router.push(next));
  };
  useEffect(() => {
    if (workbenchEntryEnabled) router.prefetch('/workspace');
  }, [router, workbenchEntryEnabled]);
  const [form, setForm] = useState<FormState>(initialFormState);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<
    import('@/lib/types/settings').SettingsSection | undefined
  >(undefined);

  // Draft cache for requirement text
  const {
    cachedValue: cachedRequirement,
    updateCache: updateRequirementCache,
    clearCache: clearRequirementCache,
  } = useDraftCache<string>({ key: COMPOSER_DRAFT_KEY });

  // A usable LLM provider exists ⇒ a concrete model is always selected (#580
  // invariant). Gate generation on this single condition (state A vs B)
  // instead of inspecting modelId directly.
  const providersConfig = useSettingsStore((s) => s.providersConfig);
  const hasUsableProvider = hasUsableLLMProvider(providersConfig);
  const [recentOpen, setRecentOpen] = useState(true);
  const persistRecentOpen = (next: boolean) => {
    setRecentOpen(next);
    try {
      localStorage.setItem(RECENT_OPEN_STORAGE_KEY, String(next));
    } catch {
      /* ignore */
    }
  };

  // Hydrate client-only state after mount (avoids SSR mismatch)
  useEffect(() => {
    try {
      const saved = localStorage.getItem(RECENT_OPEN_STORAGE_KEY);
      if (saved !== null) setRecentOpen(saved !== 'false');
    } catch {
      /* localStorage unavailable */
    }
    try {
      const savedInteractiveMode = localStorage.getItem(INTERACTIVE_MODE_STORAGE_KEY);
      if (savedInteractiveMode === 'true') {
        setForm((prev) => ({ ...prev, interactiveMode: true }));
      }
    } catch {
      /* localStorage unavailable */
    }
  }, []);

  // Restore requirement draft from localStorage on mount. The previous derived-state
  // pattern initialised `prev` from the cached value itself, so on the first client
  // render the comparison was always equal and the restore never fired. Use an effect
  // so the cache is hydrated into the form once we know the live requirement is empty.
  const draftRestoredRef = useRef(false);
  useEffect(() => {
    if (draftRestoredRef.current) return;
    if (!cachedRequirement) return;
    draftRestoredRef.current = true;
    setForm((prev) => (prev.requirement ? prev : { ...prev, requirement: cachedRequirement }));
  }, [cachedRequirement]);

  const [themeOpen, setThemeOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True while the Generate click drains upload-time ingests and builds the
  // generation session. Doubles as the guard flag that freezes the course
  // material set for the duration of prep and as the switch that disables the
  // toolbar's add/remove affordances, so the session is always built from a
  // set that cannot change under it.
  const [preparingGenerate, setPreparingGenerate] = useState(false);
  // True once the directory restore has settled (see the effect below), whether
  // it found a stored list or not. Until then the chapter set on screen is not
  // yet the user's chapter set, and generating from it would build a session
  // that silently omits every restored chapter.
  const [directoryRestored, setDirectoryRestored] = useState(false);
  // Stricter than `directoryRestored`, which settles on failure too: this is
  // true only once the store has actually *replied* about the directory. It
  // gates the write-back below, because a list that has not been read is not
  // the user's list — and writing one back while it is empty erases the stored
  // directory rather than saving anything (see `course-material-persistence`).
  const [directoryLoaded, setDirectoryLoaded] = useState(false);
  const [classrooms, setClassrooms] = useState<StageListItem[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, Slide>>({});
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Course folders — device-local grouping. `currentFolderId === undefined`
  // is the root view (folders + unfiled courses); a folder id navigates into
  // that folder's course list. Searching flattens every course regardless of
  // folder and annotates each with its folder name.
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  // True once the initial classroom + folder loads resolve. Guards layout
  // selection so the hero does not flip between full-screen and compact as the
  // two async reads land (avoids a visible layout shift on first paint).
  const [hydrated, setHydrated] = useState(false);
  const [currentFolderId, setCurrentFolderId] = useState<string | undefined>(undefined);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  // When set, the new-folder dialog is creating a folder AND moving this course
  // into it (entered via the move-menu's "new folder" entry).
  const [createAndMoveTarget, setCreateAndMoveTarget] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const thumbnailsRef = useRef<Record<string, Slide>>({});

  const replaceThumbnails = (slides: Record<string, Slide>) => {
    const previous = thumbnailsRef.current;
    thumbnailsRef.current = slides;
    setThumbnails(slides);
    window.setTimeout(() => revokeThumbnailSlideMediaUrls(previous), 0);
  };

  // Close dropdowns when clicking outside
  useEffect(() => {
    if (!themeOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
        setThemeOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [themeOpen]);

  const loadClassrooms = async () => {
    try {
      const list = await listStages();
      setClassrooms(list);
      // Load first slide thumbnails
      if (list.length > 0) {
        const slides = await getFirstSlideByStages(list.map((c) => c.id));
        replaceThumbnails(slides);
      } else {
        replaceThumbnails({});
      }
    } catch (err) {
      log.error('Failed to load classrooms:', err);
      // A 401 means the access-code gate has not admitted this browser yet —
      // the gate modal owns that message, and a "persistence is unavailable"
      // toast next to it reads as a broken library rather than a locked one.
      if (!String(err).includes('HTTP 401')) {
        toast.error('Persistence is unavailable. Saved classrooms could not be loaded.');
      }
    }
  };

  const loadFolders = async () => {
    try {
      setFolders(await listFolders());
    } catch (err) {
      log.error('Failed to load folders:', err);
    }
  };

  // Capture the active folder when an import starts so the imported course
  // lands in that folder, not whichever folder is active when the async import
  // resolves (the user may have navigated away in the meantime).
  const importFolderRef = useRef<string | undefined>(undefined);
  const handleImportSuccess = async (importedStageId: string) => {
    const folderId = importFolderRef.current;
    importFolderRef.current = undefined;
    // File the imported course into the folder that was active when the
    // import began, before refreshing the list so the card appears in place.
    if (folderId) {
      try {
        await setStageFolder(importedStageId, folderId);
      } catch (err) {
        log.error('Failed to assign imported course to folder:', err);
        toast.error(t('classroom.moveFailed'));
      }
    }
    await loadClassrooms();
  };
  const { importing, fileInputRef, triggerFileSelect, handleFileChange } =
    useImportClassroom(handleImportSuccess);
  const triggerImport = () => {
    importFolderRef.current = currentFolderId;
    triggerFileSelect();
  };

  const {
    importing: pptxImporting,
    fileInputRef: pptxFileInputRef,
    triggerFileSelect: triggerPptxFileSelect,
    handleFileChange: handlePptxFileChange,
  } = useImportPptx();

  useEffect(() => {
    // Clear stale media store to prevent cross-course thumbnail contamination.
    // The store may hold tasks from a previously visited classroom whose elementIds
    // (gen_img_1, etc.) collide with other courses' placeholders.
    useMediaGenerationStore.getState().revokeObjectUrls();
    useMediaGenerationStore.setState({ tasks: {} });

    // Read sessionStorage on the client only (avoids SSR hydration mismatch).
    // Both reads resolve before flipping `hydrated`, so the hero layout does
    // not thrash as each lands independently.
    void Promise.all([loadClassrooms(), loadFolders()]).finally(() => setHydrated(true));

    // Courses can arrive in the background (the one-way import of what this
    // browser stored before persistence moved to the server).
    const onLibraryChanged = () => {
      void Promise.all([loadClassrooms(), loadFolders()]);
    };
    window.addEventListener(LIBRARY_CHANGED_EVENT, onLibraryChanged);

    return () => {
      window.removeEventListener(LIBRARY_CHANGED_EVENT, onLibraryChanged);
      revokeThumbnailSlideMediaUrls(thumbnailsRef.current);
      thumbnailsRef.current = {};
    };
  }, []);

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setPendingDeleteId(id);
  };

  const confirmDelete = async (id: string) => {
    setPendingDeleteId(null);
    try {
      await deleteStageData(id);
      await loadClassrooms();
    } catch (err) {
      log.error('Failed to delete classroom:', err);
      toast.error('Failed to delete classroom');
    }
  };

  const handleRename = async (id: string, newName: string) => {
    try {
      await renameStage(id, newName);
      setClassrooms((prev) => prev.map((c) => (c.id === id ? { ...c, name: newName } : c)));
    } catch (err) {
      log.error('Failed to rename classroom:', err);
      toast.error(t('classroom.renameFailed'));
    }
  };

  // ─── Folder handlers ────────────────────────────────────────────────
  const handleCreateFolder = async (name: string) => {
    const folder = await createFolder(name);
    setFolders((prev) => [...prev, folder]);
    // If this create came from the move-menu's "new folder" entry, move the
    // requesting course into the freshly created folder.
    if (createAndMoveTarget) {
      await handleMoveCourse(createAndMoveTarget, folder.id);
      setCreateAndMoveTarget(null);
    }
  };

  const handleRenameFolder =
    (folder: FolderRecord) =>
    async (newName: string): Promise<string | null> => {
      // Empty or unchanged input just exits editing without an error.
      const trimmed = newName.trim();
      if (!trimmed || trimmed === folder.name) return null;
      try {
        await renameFolder(folder.id, newName);
        setFolders((prev) => prev.map((f) => (f.id === folder.id ? { ...f, name: trimmed } : f)));
        return null;
      } catch (err) {
        if (err instanceof FolderNameError) {
          if (err.kind === 'duplicate') return t('classroom.folderNameExists');
          if (err.kind === 'tooLong')
            return t('classroom.folderWidth', {
              width: displayNameWidth(trimmed),
              max: FOLDER_NAME_MAX_WIDTH,
            });
          return t('classroom.folderNameHint');
        }
        log.error('Failed to rename folder:', err);
        return t('classroom.folderRenameFailed');
      }
    };

  /**
   * Drop a folder's materials along with the folder.
   *
   * Only `'remove'` needs this. `'ungroup'` deliberately leaves the rows alone:
   * the courses that were filed in the folder become unfiled, and the chapter
   * lists that describe them have to come back to the root with them — which
   * they do by themselves, because a `folderId` no folder answers to is an
   * unfiled row as far as the view is concerned (see `courseMaterialsInView`).
   */
  const dropMaterialsOfFolder = (folderId: string) => {
    const dropped = form.courseMaterials.filter((item) => item.folderId === folderId);
    if (dropped.length === 0) return;
    // The bytes belong to the directory: drop them with the rows, exactly as
    // removing a single chapter does, so deleting a folder really frees them.
    for (const item of dropped) {
      if (!item.storageKey) continue;
      void deleteDocumentBlob(item.storageKey).catch((err) => {
        log.warn('Could not drop the removed material bytes:', err);
      });
    }
    setForm((prev) => ({
      ...prev,
      courseMaterials: prev.courseMaterials.filter((item) => item.folderId !== folderId),
    }));
  };

  const confirmDeleteFolder = async (folder: FolderRecord, mode: DeleteFolderMode) => {
    try {
      await deleteFolder(folder.id, mode);
      if (mode === 'remove') dropMaterialsOfFolder(folder.id);
      if (currentFolderId === folder.id) setCurrentFolderId(undefined);
    } catch (err) {
      log.error('Failed to delete folder:', err);
      toast.error(t('classroom.folderDeleteFailed'));
    } finally {
      // Always refresh authoritative state: in 'remove' mode a partial failure
      // may have durably deleted some courses before throwing, and the UI must
      // reflect that rather than leaving stale cards/counts behind.
      await Promise.all([loadFolders(), loadClassrooms()]);
    }
  };

  const handleMoveCourse = async (stageId: string, folderId: string | undefined) => {
    // Optimistic update for snappy UI; the persistence call follows.
    setClassrooms((prev) => prev.map((c) => (c.id === stageId ? { ...c, folderId } : c)));
    try {
      await setStageFolder(stageId, folderId);
    } catch (err) {
      log.error('Failed to move course:', err);
      toast.error(t('classroom.moveFailed'));
      // Revert on failure.
      await loadClassrooms();
    }
  };

  // From the move-menu's "new folder" entry: remember the course, then open the
  // folder dialog. The actual create+move happens in handleCreateFolder once the
  // name is confirmed. (A Radix DropdownMenu is modal, so the name input cannot
  // live inside it; the dialog is the focus surface.)
  const handleCreateAndMove = (stageId: string) => () => {
    setCreateAndMoveTarget(stageId);
    setNewFolderOpen(true);
  };

  const deferredSearchQuery = useDeferredValue(searchQuery);
  const filteredClassrooms = useMemo(() => {
    const q = deferredSearchQuery.trim().toLowerCase();
    if (!q) return classrooms;
    return classrooms.filter((c) => {
      const name = c.name?.toLowerCase() ?? '';
      const desc = c.description?.toLowerCase() ?? '';
      return name.includes(q) || desc.includes(q);
    });
  }, [classrooms, deferredSearchQuery]);

  // The courseware a NON-search list renders from: the teaching lessons only.
  // "单元测试" / "案例教学" are generated from the same material as the lesson and
  // are kept off the home grid and the folder tiles — but they stay in
  // `classrooms`, which is also the reuse predicate's search set (see
  // `runGeneration`). Filtering THAT list would make every click generate a new
  // course instead of reopening the existing one, so the projection lives here
  // and only here. Searching is exempt on purpose — see `visibleClassrooms`.
  const coursewareClassrooms = useMemo(() => classrooms.filter(isCourseware), [classrooms]);

  // Folder-aware view model. Searching collapses the hierarchy: every matching
  // course is shown flat, annotated with its folder name. Otherwise the root
  // view shows folder tiles + unfiled courses, and a folder view shows only
  // that folder's members.
  const folderNameById = useMemo(() => new Map(folders.map((f) => [f.id, f.name])), [folders]);
  // The folder ids that still exist. An id missing from here is a folder that
  // was deleted, which is how both views below tell "filed under a folder that
  // is gone" (show it at the root) from "filed under a folder with nothing in
  // it" (show nothing).
  const folderIds = useMemo(() => new Set(folders.map((f) => f.id)), [folders]);
  const isSearching = deferredSearchQuery.trim().length > 0;
  // The course tiles rendered in the active view: search flattens everything;
  // a folder shows only its members; the root shows unfiled courses (folder
  // tiles are rendered separately above them).
  const visibleClassrooms = useMemo(() => {
    // Searching stays over the WHOLE list: the assessments are hidden from the
    // two browsing views, and the search results are the only remaining door to
    // rename, move or delete one.
    if (isSearching) return filteredClassrooms;
    if (currentFolderId) return coursewareClassrooms.filter((c) => c.folderId === currentFolderId);
    return coursewareClassrooms.filter((c) => c.folderId === undefined || !folderIds.has(c.folderId));
  }, [filteredClassrooms, coursewareClassrooms, isSearching, currentFolderId, folderIds]);
  // Pairs with the `classroom.emptyFolderHint` branch below: a folder holding
  // nothing but assessments must read as EMPTY, not as a folder with an
  // invisible member (which would render neither the grid nor the hint — a
  // blank panel).
  const currentFolderClassrooms = useMemo(
    () => (currentFolderId ? coursewareClassrooms.filter((c) => c.folderId === currentFolderId) : []),
    [coursewareClassrooms, currentFolderId],
  );
  const courseCountByFolder = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of coursewareClassrooms) {
      if (c.folderId) counts.set(c.folderId, (counts.get(c.folderId) ?? 0) + 1);
    }
    return counts;
  }, [coursewareClassrooms]);
  // Up to 3 member course covers (first-slide thumbnails) per folder, for the
  // folder tile's cover stack. Members are ordered by updatedAt desc so the
  // frontmost cover is the most recently touched course.
  const coverSlidesByFolder = useMemo(() => {
    const byFolder = new Map<string, Slide[]>();
    for (const c of [...coursewareClassrooms].sort((a, b) => b.updatedAt - a.updatedAt)) {
      if (!c.folderId) continue;
      const slide = thumbnails[c.id];
      if (!slide) continue;
      const list = byFolder.get(c.folderId) ?? [];
      if (list.length < 3) list.push(slide);
      byFolder.set(c.folderId, list);
    }
    return byFolder;
  }, [coursewareClassrooms, thumbnails]);
  const currentFolder = folders.find((f) => f.id === currentFolderId);

  // Chapter selection is resolved at read time, never trusted as stored state.
  // A selection can go stale through paths that never touch it — the user
  // deleting that row, or the toolbar's extractor-switch cleanup dropping the
  // material in bulk — so deriving "selected and still present" here immunises
  // every removal path at once instead of patching each one. A stale selection
  // degrades to null, which is the merge-everything path, not an empty one.
  //
  // It resolves against the **whole** list, not the folder on screen: the
  // selection is one stored slot, and writing the view-resolved value back
  // would erase the user's choice the moment they glanced at another folder.
  // What the view should show is `visibleSelectedMaterialId` below.
  const effectiveSelectedMaterialId =
    form.selectedMaterialId &&
    form.courseMaterials.some((material) => material.id === form.selectedMaterialId)
      ? form.selectedMaterialId
      : null;

  // ─── The folder view over the material directory ──────────────
  // Folders group generated courses, and the chapter directory follows them:
  // opening a folder shows the chapters filed under it. The directory itself
  // stays one list — see `courseMaterialsInView` — so opening a folder only
  // changes what is *rendered*, never what is read, written or restored.
  //
  // The ordinals are re-derived here, from the position in the list being
  // shown, rather than trusted from the stored rows. Two cases need it and
  // neither can be fixed where the rows were written: a folder deleted on
  // another device leaves this one with rows filed under an id no folder
  // answers to, which surface at the root, and the root's own numbering has to
  // absorb them; and a stored list edited by an older build of the app carries
  // whatever numbering that build used. Deriving "which chapter is this" from
  // the view is the same move as `effectiveSelectedMaterialId` below, and it
  // makes every consumer — the panel's numbers, the selected-chapter badge, the
  // upload limits — agree by construction.
  const visibleMaterials = useMemo(() => {
    const rows = courseMaterialsInView(form.courseMaterials, {
      folderId: currentFolderId,
      knownFolderIds: folderIds,
    }).sort((a, b) => a.order - b.order);
    return rows.map((material, index) =>
      material.order === index + 1 ? material : { ...material, order: index + 1 },
    );
  }, [form.courseMaterials, currentFolderId, folderIds]);

  // The selection as *this view* resolves it: a chapter selected in another
  // folder is not a selection here. Without this the single stored slot would
  // leak across folders and a generate issued while browsing an empty folder
  // would quietly ingest the chapter selected in the previous one.
  const visibleSelectedMaterialId =
    effectiveSelectedMaterialId &&
    visibleMaterials.some((material) => material.id === effectiveSelectedMaterialId)
      ? effectiveSelectedMaterialId
      : null;

  // A "back to home" reset issued from another route has to beat the restore
  // below. The reset clears the stored selection with a fire-and-forget write,
  // so a restore that reads the row a moment too early would bring the old
  // selection back — the reset would look like it worked only when the server
  // was slow. The flag is set synchronously at click time, so it answers "should
  // a selection come back" without waiting for that write, and it is consumed
  // here because this mount is the one it was meant for.
  const pendingComposerResetRef = useRef(false);
  useEffect(() => {
    pendingComposerResetRef.current = consumePendingHomeComposerReset();
  }, []);

  // ─── Chapter directory persistence ────────────────────────────
  // The directory is restored from the synced KV list on mount and written
  // back whenever it changes. Both halves are best-effort and silent: on a
  // deployment without server persistence every call here is a no-op, and the
  // page behaves exactly as it did before, with the list living in this tab.

  // The restore runs once. It is asynchronous, so a user who starts attaching
  // files before it lands keeps their work: the restore never replaces a
  // directory that already has chapters in it.
  //
  // `directoryRestored` is set when it settles — found, not found, or failed —
  // and gates generation, because the list this page renders is not the user's
  // list until the read has answered. A chapter restored from another device
  // has exactly the same bytes-missing shape as no chapter at all, so a
  // generate that raced past the restore would produce a lesson with the
  // materials quietly absent, which is the failure this whole directory exists
  // to prevent. A deployment without persistence resolves this immediately.
  useEffect(() => {
    let cancelled = false;
    // Set once a stored list has answered. A retry is only owed while the read
    // has never had an answer: otherwise a broadcast from the importer would
    // re-read — and could resurrect — a directory the user has since cleared.
    let readAnswered = false;
    const restoreDirectory = async () => {
      try {
        const result = await readHomeMaterialsResult();
        readAnswered = result.answered;
        const stored = result.stored;
        if (!stored) return;
        if (cancelled) return;
        const restored = await restoreCourseMaterials(stored);
        if (cancelled) return;
        setForm((prev) =>
          prev.courseMaterials.length > 0
            ? prev
            : {
                ...prev,
                courseMaterials: restored,
                selectedMaterialId: pendingComposerResetRef.current
                  ? null
                  : stored.selectedMaterialId,
              },
        );
      } finally {
        if (!cancelled) {
          // Deliberately here rather than the moment the read answers, and the
          // difference is not cosmetic. Restoring the bytes takes an await, so
          // flagging earlier would leave a render — one that can last as long
          // as IndexedDB takes — in which "the directory has been read" is true
          // while the list it produced is not in state yet. The write-back
          // effect runs on exactly that render, sees an empty list it is now
          // allowed to erase, and deletes the stored directory only to write it
          // straight back: a needless destroy-and-recreate with a real window
          // in the middle. Set with the chapters already in state, the flag can
          // only ever go true over a list that reflects what was read.
          if (readAnswered) setDirectoryLoaded(true);
          setDirectoryRestored(true);
        }
      }
    };
    void restoreDirectory();

    // This read meets the same 401 as the course list above, and for the same
    // reason: it runs on mount, before the access cookie exists, and never
    // asks again — so a folder opened right after entering the code reported
    // "no chapters yet" until a reload. Re-running it when the gate admits
    // the browser (or when anything else announces the library changed) is
    // what makes an unlocked folder list its chapters in place.
    const onLibraryChanged = () => {
      if (readAnswered) return;
      void restoreDirectory();
    };
    window.addEventListener(LIBRARY_CHANGED_EVENT, onLibraryChanged);

    return () => {
      cancelled = true;
      window.removeEventListener(LIBRARY_CHANGED_EVENT, onLibraryChanged);
    };
  }, []);

  // Write the directory back after every change. No debounce: the writes are
  // serialized in `writeHomeMaterials`, so issuing one per change is both
  // correct and cheap (a batch attach produces two: the rows, then their
  // storage keys), and there is no timer window in which a change could be
  // lost to a reload.
  //
  // Two gates stand between a change and that write, and both are about the
  // same thing: the list in memory is only the user's list once the stored one
  // has been read.
  //
  // The mount render is skipped — the restore above has not resolved yet, so
  // the list is still empty and writing it would erase the stored directory.
  // `directoryWriteArmedRef` covers exactly that first render and no more; a
  // later change still has to clear the second gate.
  //
  // That second gate is the read itself (`directoryLoaded`). Until the store
  // has replied, a change here is a change to a list that was never loaded, and
  // a write-back replaces the whole record — so an in-memory list that is empty
  // because the read has not landed would delete the user's directory instead
  // of saving it. `allowEmpty` carries the same claim to the store, which
  // refuses an empty list unless it is told the read happened; that refusal is
  // what keeps this safe even if a future caller forgets the gate.
  //
  // A page whose read never answers therefore stops writing, which is the
  // intended trade: on a deployment that cannot be read from, a write would
  // fail anyway, whereas a write that erases is not recoverable.
  const directoryWriteArmedRef = useRef(false);
  // Whether this page has ever held a chapter in memory. Erasing is only ever
  // earnt: a list that is empty *and always has been* describes a page with
  // nothing of its own to save, and the delete it would issue can only destroy
  // something this page never saw — a directory another device stored between
  // the read and this write. Skipping it costs nothing, because a delete of an
  // already-empty record has no effect anyway. Declared before the write effect
  // so it is updated first within a commit.
  const heldMaterialsRef = useRef(false);
  useEffect(() => {
    if (form.courseMaterials.length > 0) heldMaterialsRef.current = true;
  }, [form.courseMaterials]);
  useEffect(() => {
    if (!directoryWriteArmedRef.current) {
      directoryWriteArmedRef.current = true;
      return;
    }
    if (!directoryLoaded) return;
    void writeHomeMaterials(
      {
        materials: form.courseMaterials,
        selectedMaterialId: effectiveSelectedMaterialId,
      },
      // Both halves of the claim that this empty list is the user's doing: the
      // stored directory was read, and this page held chapters of its own to
      // empty. An empty list that fails either test is a page still starting
      // up, and the store is told to keep its row.
      { allowEmpty: heldMaterialsRef.current },
    );
  }, [form.courseMaterials, effectiveSelectedMaterialId, directoryLoaded]);

  const updateForm = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    try {
      if (field === 'interactiveMode')
        localStorage.setItem(INTERACTIVE_MODE_STORAGE_KEY, String(value));
      if (field === 'requirement') updateRequirementCache(value as string);
    } catch {
      /* ignore */
    }
  };

  /**
   * Put a newly attached file's bytes in this device's IndexedDB and record
   * the key on the row — and compute the row's content digest while the bytes
   * are being read anyway.
   *
   * Deliberately not awaited by the caller: the chapter appears instantly and
   * its key lands a moment later, so attaching a dozen files stays one
   * gesture. The key is what lets the chapter directory be rebuilt after a
   * reload — without it a restored row would have no way back to its bytes —
   * and a file whose key never arrives degrades to the same visible-but-needs-
   * reselecting state as a row restored on another device.
   *
   * The digest is the other half of that durability: it is what names the
   * extraction the server has already done for these bytes, so a chapter can
   * be resolved back to its archived markdown from a device that no longer
   * holds the file. Both halves are independent — a row may get one, the
   * other, both, or (on a storage failure) neither.
   */
  const captureMaterialStorageKeys = async (additions: readonly { id: string; file?: File }[]) => {
    const captured = await Promise.all(
      additions.map(async ({ id, file }) => {
        if (!file) return null;
        const [storageKey, contentDigest] = await Promise.all([
          storeDocumentBlob(file).catch((err: unknown) => {
            log.warn('Could not cache the material bytes for the chapter directory:', err);
            return undefined;
          }),
          computeContentDigest(file),
        ]);
        return { id, storageKey, contentDigest };
      }),
    );
    const capturedById = new Map<
      string,
      { storageKey: string | undefined; contentDigest: string | undefined }
    >();
    for (const entry of captured) {
      if (entry) capturedById.set(entry.id, entry);
    }
    if (capturedById.size === 0) return;
    // One update for the whole batch rather than one per file: every update is
    // a write to the synced row, and a dozen of them for a single attach is a
    // dozen chances to land out of order.
    setForm((prev) => {
      let changed = false;
      const courseMaterials = prev.courseMaterials.map((item) => {
        const got = capturedById.get(item.id);
        if (!got) return item;
        const storageKey = item.storageKey ?? got.storageKey;
        const contentDigest = item.contentDigest ?? got.contentDigest;
        if (storageKey === item.storageKey && contentDigest === item.contentDigest) return item;
        changed = true;
        return {
          ...item,
          ...(storageKey ? { storageKey } : {}),
          ...(contentDigest ? { contentDigest } : {}),
        };
      });
      return changed ? { ...prev, courseMaterials } : prev;
    });
  };

  const addCourseMaterials = (files: File[]) => {
    // The set is frozen for the duration of generate-prep: adding is inert
    // while `preparingGenerate` is set (the toolbar affordance is disabled
    // via the same state), so nothing can slip into the set mid-prep.
    if (preparingGenerate) return;
    // Attached into the folder on screen, and therefore filed under it. Both
    // the dedupe and the numbering are scoped to that folder: the same file in
    // two folders is two entries (they are separate chapter lists), and each
    // folder numbers its own chapters from 1.
    const folderId = currentFolderId;
    const dedupedFiles = dedupeCourseMaterialFiles(visibleMaterials, files);
    const startOrder = visibleMaterials.length + 1;
    const additions = dedupedFiles.map((file, index) => ({
      id: nanoid(8),
      file,
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      type: file.type,
      order: startOrder + index,
      ...(folderId ? { folderId } : {}),
    }));

    if (additions.length === 0) return;
    setForm((prev) => {
      // Pure updater: drop any addition the latest state already carries — by
      // id (a replayed or superseded update) or by content fingerprint *within
      // this folder* (two addCourseMaterials calls in one render batch both
      // dedupe against the same stale closure list, so the same file could
      // otherwise enter twice under two ids and ingest/extract twice) — then
      // append the rest. The fingerprint check re-derives the view from `prev`
      // rather than reusing the closure's list, so the guard sees the same rows
      // the dedupe above did.
      const alreadyFiled = courseMaterialsInView(prev.courseMaterials, {
        folderId,
        knownFolderIds: folderIds,
      });
      const missing = additions.filter((addition) => {
        if (prev.courseMaterials.some((item) => item.id === addition.id)) return false;
        return !alreadyFiled.some(
          (item) => courseMaterialFingerprint(item) === courseMaterialFingerprint(addition),
        );
      });
      if (missing.length === 0) return prev;
      return { ...prev, courseMaterials: [...prev.courseMaterials, ...missing] };
    });
    // Capture the bytes for the rows just added, so the directory survives a
    // reload on this device (see `restoreCourseMaterials`).
    void captureMaterialStorageKeys(additions);
  };

  const removeCourseMaterial = (id: string) => {
    // The set is frozen for the duration of generate-prep: removing is inert
    // while `preparingGenerate` is set (the toolbar affordance is disabled
    // via the same state), so nothing can slip out of the set mid-prep.
    if (preparingGenerate) return;
    // The cached bytes belong to the directory, not to the page: drop them with
    // the row so removing a chapter really frees the space. Safe because a
    // prepare in flight freezes this list (the guard above), so no session can
    // be holding the key that is about to be deleted.
    const removed = form.courseMaterials.find((item) => item.id === id);
    if (removed?.storageKey) {
      void deleteDocumentBlob(removed.storageKey).catch((err) => {
        log.warn('Could not drop the removed material bytes:', err);
      });
    }
    setForm((prev) => {
      const target = prev.courseMaterials.find((item) => item.id === id);
      if (!target) return prev;
      // Renumber within the removed row's own folder: `order` counts positions
      // in the chapter list being shown, and deleting chapter 1 of one folder
      // must not renumber every other folder's chapters.
      let ordinal = 0;
      return {
        ...prev,
        courseMaterials: prev.courseMaterials
          .filter((item) => item.id !== id)
          .map((item) => {
            if (item.folderId !== target.folderId) return item;
            ordinal += 1;
            return item.order === ordinal ? item : { ...item, order: ordinal };
          }),
      };
    });
  };

  /**
   * Build a generation session and hand it to the preview page, for any kind of
   * lesson.
   *
   * `'lesson'` is the composer-driven path: the requirement text is the user's,
   * and the outline step produces a normal teaching classroom. `'unitQuiz'` and
   * `'caseTeaching'` are driven by the chapter directory instead — neither has a
   * composer step, so each is gated on a selected chapter and writes its own
   * requirement — and each tells the outline step to emit a single scene of its
   * own kind. Everything else is shared: the click-time snapshot, the
   * archived-derivation reuse, and the session itself.
   */
  const runGeneration = async (lessonKind: 'lesson' | 'unitQuiz' | 'caseTeaching') => {
    // No model/provider guard here: generation is gated by `canGenerate`
    // (requires a usable provider), and under the #580 invariant a usable
    // provider always has a concrete model. State A (no usable provider)
    // surfaces through the toolbar's single Configure-Provider affordance.
    if (preparingGenerate) return;
    // The composer is the ordinary path's whole input; the chapter-driven paths
    // have no composer step, so they are gated on a selected chapter instead —
    // the same condition the directory's own buttons are enabled by.
    if (lessonKind !== 'lesson') {
      if (!visibleSelectedMaterialId) return;
    } else if (!form.requirement.trim()) {
      setError(t('upload.requirementRequired'));
      return;
    }

    setError(null);

    // The material list and the extractor provider config are frozen for the
    // duration of prep: `preparingGenerate` makes add/remove inert and
    // disables the toolbar affordances (including the extractor Select and the
    // web-search toggle), so neither can change under the session build below.
    // Capture both at click time and build the session from this snapshot,
    // never from live form state or live store state.
    //
    // The snapshot is the *folder on screen*, not the whole directory: folders
    // are separate chapter lists, so generating from inside one must not sweep
    // up every other folder's materials. This is the one place where using the
    // unfiltered list would be silently wrong rather than merely untidy — the
    // lesson would come out with chapters the user cannot see.
    const frozenMaterials = [...visibleMaterials].sort((a, b) => a.order - b.order);
    // The folder is frozen the same way, and for the same reason: the course is
    // filed into the folder that was on screen when the user pressed Enter, not
    // whichever folder is active by the time the async generation resolves (the
    // preview page has navigated them away by then). Undefined means the user
    // generated from the root view — the course stays unfiled, which is the
    // behaviour every generation had before this was added. Mirrors the
    // `importFolderRef` capture in the import flow below.
    const frozenFolderId = currentFolderId;
    // Chapter selection is applied here, from the same click-time snapshot, and
    // deliberately before anything is stored or extracted: the unselected
    // chapters are never copied to a blob and never sent for extraction, so the
    // saving is real work avoided rather than a smaller prompt over the same
    // cost. `order` is reassigned in the loop below, which means the selected
    // chapter becomes order 1 and every order-driven consumer downstream
    // (extraction ordering, section headers, stable image ids, the legacy
    // pdfStorageKey) keeps working with no special case.
    const frozenSelectedMaterialId = visibleSelectedMaterialId;
    const materialsToIngest = frozenSelectedMaterialId
      ? frozenMaterials.filter((material) => material.id === frozenSelectedMaterialId)
      : frozenMaterials;
    // A chapter restored from the synced directory on a device that never held
    // its bytes is still usable: the extraction of those bytes is archived
    // server-side under the digest the directory carries, and the generation
    // step falls back to it rather than parsing bytes it does not have (see
    // `parseSource` in the generation preview). What cannot be resolved is a
    // chapter with *neither* bytes nor a digest — an entry stored before
    // digests existed, or one whose browser cannot compute one — so only that
    // is refused, by name, before anything is copied or sent.
    // The same predicate the chapter directory renders by, so a row that looks
    // usable here and there cannot be refused on generate.
    const ungeneratable = materialsToIngest.find((material) => !isCourseMaterialUsable(material));
    if (ungeneratable) {
      setError(t('toolbar.chapterFileMissingNamed', { name: ungeneratable.name }));
      return;
    }
    const settingsSnapshot = useSettingsStore.getState();
    const frozenPdfProviderId = settingsSnapshot.pdfProviderId;
    const frozenPdfProviderConfig = settingsSnapshot.pdfProvidersConfig?.[
      settingsSnapshot.pdfProviderId
    ]
      ? {
          apiKey: settingsSnapshot.pdfProvidersConfig[settingsSnapshot.pdfProviderId].apiKey,
          baseUrl: settingsSnapshot.pdfProvidersConfig[settingsSnapshot.pdfProviderId].baseUrl,
          accessKeyId:
            settingsSnapshot.pdfProvidersConfig[settingsSnapshot.pdfProviderId].accessKeyId,
          accessKeySecret:
            settingsSnapshot.pdfProvidersConfig[settingsSnapshot.pdfProviderId].accessKeySecret,
        }
      : undefined;

    // Flip the generating UI state before material bytes are copied locally.
    setPreparingGenerate(true);
    try {
      const userProfile = useUserProfileStore.getState();
      const requirements: UserRequirements = {
        // The chapter-driven paths have no composer, so each states its own
        // intent. What routes the outline step is `lessonKind` below, not this
        // text — this is only what the model reads.
        requirement:
          lessonKind === 'unitQuiz'
            ? t('toolbar.unitQuizRequirement', { name: materialsToIngest[0]?.name ?? '' })
            : lessonKind === 'caseTeaching'
              ? t('toolbar.caseTeachingRequirement', { name: materialsToIngest[0]?.name ?? '' })
              : form.requirement,
        userNickname: userProfile.nickname || undefined,
        userBio: userProfile.bio || undefined,
        // Course-level web search now lives in settings (课程模型配置 → 联网调研)
        webSearch: useSettingsStore.getState().webSearchEnabled || undefined,
        // The three paths carry different generation switches and none should
        // leak into another: the single-scene kinds are never interactive-first
        // and never vocational, so each sets its own kind and nothing else.
        ...(lessonKind === 'lesson'
          ? {
              interactiveMode: form.vocationalTestMode ? true : form.interactiveMode,
              ...(form.vocationalTestMode ? { taskEngineMode: true } : {}),
            }
          : { lessonKind }),
      };

      // Copy the click-time snapshot's bytes into this device's blob store and
      // describe them as session sources. More than one branch needs this — a
      // normal generation to parse and bundle them, and the extract-only
      // session below to run the parse an existing classroom's chapters read
      // from — so it is built here, once, rather than inside either caller.
      const buildDocumentSources = async (
        providerId: string | undefined,
      ): Promise<SessionDocumentSource[]> => {
        const sources: SessionDocumentSource[] = [];
        const storedDocumentKeys: string[] = [];
        try {
          for (const [index, item] of materialsToIngest.entries()) {
            const file = item.file;
            // Reuse the key captured when the file was attached: those bytes
            // are already in this device's IndexedDB — that is precisely what
            // lets the directory survive a reload — so storing them again
            // would only duplicate the file. A key stored here belongs to the
            // session and is rolled back below if this loop throws; a reused
            // one is the directory's and is not.
            let storageKey = item.storageKey;
            if (file) {
              if (!storageKey) {
                storageKey = await storeDocumentBlob(file);
                storedDocumentKeys.push(storageKey);
              }
            } else if (!storageKey) {
              // The guard above admits a chapter without bytes only when it
              // carries a digest, and a stored directory entry always carries
              // the key those bytes live under on the device that uploaded
              // them. A resolved source needs that key (`SessionDocumentSource`
              // requires it), so an entry with neither is not one this session
              // can be built from.
              throw new Error(`${item.name} is not available on this device`);
            }
            sources.push({
              id: item.id,
              name: item.name,
              size: item.size,
              lastModified: item.lastModified,
              // The MIME type comes from the file when there is one and from
              // the directory row otherwise; a restored row stores the type it
              // was uploaded with, which is the value `file.type` gave.
              mimeType: normalizeDocumentMimeType({
                mimeType: file?.type ?? item.type,
                fileName: item.name,
              }),
              order: index + 1,
              storageKey,
              providerId,
              ...(item.contentDigest ? { contentDigest: item.contentDigest } : {}),
            });
          }
        } catch (error) {
          await Promise.allSettled(storedDocumentKeys.map((key) => deleteDocumentBlob(key)));
          throw error;
        }
        return sources;
      };

      // ── Materials that already produced a classroom ──
      // The same file uploaded again is how the user asks for the classroom it
      // already produced — to open it, or to fill in the extraction its
      // chapters read from — and never how they ask for a second one from
      // identical material. The link is `Stage.sourceDigests`, matched against
      // the course list this page already holds, so recognizing it costs no
      // extra request. Only a real match redirects: material that no course
      // names, and material from before the link existed (no digests), both
      // generate normally. Among several matches the most recently updated
      // one wins, which is the order `classrooms` arrives in.
      const digestSet = new Set(
        materialsToIngest
          .map((material) => material.contentDigest)
          .filter((digest): digest is string => typeof digest === 'string' && digest.length > 0),
      );
      // A match means the classroom was generated from *everything* selected
      // now — not merely from something. Overlap alone accepts the case this is
      // most likely to meet: a folder already holding the course its first
      // chapters produced, one more chapter uploaded later, generating without
      // narrowing the selection. That course predates the new chapter, so
      // reusing it would drop the chapter the user just added — quietly, since
      // the archive still receives it. Requiring containment turns that into a
      // second course built from all the selected material, which is the honest
      // reading of "generate from these".
      const existingClassroom =
        digestSet.size > 0
          ? classrooms.find(
              (classroom) =>
                // A quiz classroom and the teaching classroom built from the
                // same material carry the same digests, so the digest match
                // alone cannot tell them apart — and reopening the wrong one
                // would hand the user a lesson of the other kind. Courses
                // generated before `lessonKind` existed have none, and read as
                // teaching lessons, which is exactly what they are.
                (classroom.lessonKind ?? 'lesson') === lessonKind &&
                [...digestSet].every((digest) => classroom.sourceDigests?.includes(digest)),
            )
          : undefined;
      if (existingClassroom) {
        // "Already archived" is asked per material *and* per extractor, and
        // read the same way generation reads it — including its refusal to
        // call a blank-but-successful parse usable. One chapter still missing
        // its derivation is reason enough to extract rather than skip, and is
        // exactly the case this upload exists for.
        const archived = await Promise.all(
          materialsToIngest.map((material) =>
            material.contentDigest
              ? hasUsableArchivedExtraction({
                  contentDigest: material.contentDigest,
                  ...(frozenPdfProviderId ? { extractorId: frozenPdfProviderId } : {}),
                })
              : false,
          ),
        );
        if (archived.every(Boolean)) {
          // Reusing an existing classroom still files it into the folder the
          // user generated from — but only when it has no folder yet. One that
          // is already filed elsewhere stays put: moving it silently would take
          // it away from where it was deliberately put (see
          // `docs/folder-auto-assign-analysis.md` §八·1). Unlike the create
          // path, no ordering constraint applies here: the reused classroom's
          // row already exists, so the folder route's existence check passes.
          if (frozenFolderId && !existingClassroom.folderId) {
            try {
              await setStageFolder(existingClassroom.id, frozenFolderId);
            } catch (err) {
              // Failing to file it is not failing to open it: the classroom
              // still opens, it just stays where it was.
              log.error('Failed to file reused classroom into folder:', err);
              toast.error(t('classroom.moveFailed'));
            }
          }
          toast.info(t('upload.existingClassroomOpened'));
          router.push(`/classroom/${existingClassroom.id}`);
          return;
        }

        // Extraction only. The classroom keeps its content and its id; this
        // upload exists to fill in the derivation its chapters read from, so
        // the preview page runs the extraction step and stops there
        // (`extractOnly`) instead of building a second course.
        const extractOnlySession = {
          sessionId: nanoid(),
          requirements,
          pdfText: '',
          pdfImages: [],
          imageStorageIds: [],
          documentSources: await buildDocumentSources(frozenPdfProviderId),
          pdfStorageKey: undefined,
          pdfFileName: undefined,
          documentMimeType: undefined,
          pdfProviderId: frozenPdfProviderId,
          pdfProviderConfig: frozenPdfProviderConfig,
          sceneOutlines: null,
          currentStep: 'generating' as const,
          extractOnly: true,
          targetStageId: existingClassroom.id,
        } satisfies GenerationSessionState;
        sessionStorage.setItem('generationSession', JSON.stringify(extractOnlySession));
        toast.info(t('upload.existingClassroomExtracting'));
        router.push('/generation-preview');
        return;
      }

      let documentSources: SessionDocumentSource[] | undefined;
      let pdfProviderId: string | undefined;
      let pdfProviderConfig:
        | { apiKey?: string; baseUrl?: string; accessKeyId?: string; accessKeySecret?: string }
        | undefined;

      if (materialsToIngest.length > 0) {
        // The session is built from the click-time snapshot (frozen above),
        // never from live store state.
        pdfProviderId = frozenPdfProviderId;
        pdfProviderConfig = frozenPdfProviderConfig;
        documentSources = await buildDocumentSources(frozenPdfProviderId);
      }

      const sessionState = {
        sessionId: nanoid(),
        requirements,
        pdfText: '',
        pdfImages: [],
        imageStorageIds: [],
        documentSources,
        // Backward-compatible single-document fields for previously saved sessions.
        pdfStorageKey: documentSources?.[0]?.storageKey,
        pdfFileName: documentSources?.[0]?.name,
        documentMimeType: documentSources?.[0]?.mimeType,
        pdfProviderId,
        pdfProviderConfig,
        sceneOutlines: null,
        currentStep: 'generating' as const,
        // Carried only when the user generated from a folder view, so a root
        // generation keeps the exact session shape it had before this field
        // existed. The preview page files the course only when it is present.
        ...(frozenFolderId ? { targetFolderId: frozenFolderId } : {}),
      };
      sessionStorage.setItem('generationSession', JSON.stringify(sessionState));

      router.push('/generation-preview');
    } catch (err) {
      log.error('Error preparing generation:', err);
      setError(err instanceof Error ? err.message : t('upload.generateFailed'));
    } finally {
      // Unfreeze the set once prep settles (navigation unmounts this page, so
      // this is normally a no-op on the way out).
      setPreparingGenerate(false);
    }
  };

  /** The composer-driven path: generate an ordinary teaching classroom. */
  const handleGenerate = () => runGeneration('lesson');

  /**
   * The directory-driven path: one click on the selected chapter produces a
   * quiz-only classroom — the same material, no teaching slides.
   */
  const handleUnitQuiz = () => runGeneration('unitQuiz');

  /**
   * The directory-driven case path: one click on the selected chapter produces
   * a case-teaching classroom — a single case scene built around that chapter's
   * knowledge points, with the discussion questions the learner works through.
   */
  const handleCaseTeaching = () => runGeneration('caseTeaching');

  /**
   * Selecting a chapter also writes the composer's requirement — the sentence
   * "start chapter N …" — so one click on a row is enough to arm the send
   * button. It is a suggestion, never a submission: the button lights up and
   * the user still presses it themselves.
   *
   * The write is conditional, because clicking a chapter must never eat words
   * the user typed. Only an empty composer, or one still holding the sentence
   * written here last, is written to; anything else means the user has a prompt
   * of their own, which is left untouched — and this helper forgets its own
   * sentence for good, so no later click can overwrite it either. Deselecting
   * clears exactly what was written here and nothing else.
   *
   * It deliberately does not go through `updateForm`: that writes the draft
   * cache (`requirementDraft`), and a sentence the app generated is not the
   * user's draft — it must not come back on the next visit.
   *
   * The row is looked up in `visibleMaterials`, not in `form.courseMaterials`,
   * because the number the panel shows is the view's ordinal: the stored
   * `order` of a chapter filed in another folder disagrees with it, and the
   * sentence has to name the chapter the user just clicked.
   */
  const autoFilledRequirementRef = useRef<string | null>(null);

  const applyChapterSelection = (id: string | null) => {
    const chapter = id ? visibleMaterials.find((material) => material.id === id) : undefined;
    const current = form.requirement;
    const autoFilled = autoFilledRequirementRef.current;
    const isAutoFilled = autoFilled !== null && current === autoFilled;

    let nextRequirement = current;
    let nextAutoFilled: string | null = autoFilled;

    if (id === null) {
      // Deselect: only what this helper wrote is cleared. A prompt the user
      // wrote outlives the selection it was written next to.
      if (isAutoFilled) {
        nextRequirement = '';
        nextAutoFilled = null;
      }
    } else if (chapter && (current.trim() === '' || isAutoFilled)) {
      nextRequirement = t('toolbar.chapterRequirementTemplate', {
        order: chapter.order,
        title: resolveChapterTitle(chapter, classrooms),
      });
      nextAutoFilled = nextRequirement;
    } else if (chapter) {
      nextAutoFilled = null;
    }

    autoFilledRequirementRef.current = nextAutoFilled;
    setForm((prev) => ({ ...prev, selectedMaterialId: id, requirement: nextRequirement }));
  };

  /**
   * The same "back to home" gesture, for the one case where the home page is
   * already mounted: leaving a folder is a view change (`currentFolderId`), not
   * a route change, so nothing remounts and nothing else would clear the
   * composer. The flag is consumed here rather than left for a later mount —
   * this view is the one the gesture was aimed at, and replaying it on the next
   * visit would wipe a selection the user made afterwards.
   *
   * Everything the user typed goes, not just the sentence this page wrote for a
   * selected chapter: the two are indistinguishable once edited, and the gesture
   * promises a clean start.
   */
  useEffect(() => {
    const handleReset = () => {
      consumePendingHomeComposerReset();
      clearRequirementCache();
      autoFilledRequirementRef.current = null;
      setForm((prev) => ({ ...prev, requirement: '', selectedMaterialId: null }));
    };
    window.addEventListener(HOME_COMPOSER_RESET_EVENT, handleReset);
    return () => window.removeEventListener(HOME_COMPOSER_RESET_EVENT, handleReset);
  }, [clearRequirementCache]);

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffTime = Math.abs(now.getTime() - date.getTime());
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return t('classroom.today');
    if (diffDays === 1) return t('classroom.yesterday');
    if (diffDays < 7) return `${diffDays} ${t('classroom.daysAgo')}`;
    return date.toLocaleDateString();
  };

  // Generating waits for the stored directory: `form.courseMaterials` is still
  // an empty list while the restore is in flight, and a session built from it
  // would drop every chapter the user has — which, on a device that never held
  // the bytes, are precisely the chapters that only the directory knows about.
  const canGenerate = !!form.requirement.trim() && hasUsableProvider && directoryRestored;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (canGenerate && !preparingGenerate) handleGenerate();
    }
  };

  // `relative` is the positioning context for the usage guide, which anchors
  // itself to the band of empty space right of the centred hero.
  return (
    <div className="relative min-h-[100dvh] w-full bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 flex flex-col items-center p-4 pt-16 md:p-8 md:pt-16 overflow-x-hidden">
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip"
        onChange={handleFileChange}
        className="hidden"
      />
      {PPTX_IMPORT_ENABLED && (
        <input
          ref={pptxFileInputRef}
          type="file"
          accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
          onChange={handlePptxFileChange}
          className="hidden"
        />
      )}
      {/* ═══ Top-left chapter directory ═══ */}
      {/* The chapters of the folder on screen, listed in order, so a lesson can
          be generated from a single chapter. The list lives here rather than
          inside the toolbar's upload popover so the chapters are visible
          without opening anything; which chapters those are is decided by the
          active folder (see `visibleMaterials`), and selection state stays
          owned by the form below and is only reported back up. In the root
          view it renders nothing while no unfiled material is attached; inside
          a folder it renders even when empty, so an empty folder reads as
          "this folder has no chapters yet" rather than as a missing panel. */}
      <ChapterDirectory
        courseMaterials={visibleMaterials}
        selectedMaterialId={visibleSelectedMaterialId}
        folderName={currentFolder?.name}
        onSelectMaterial={applyChapterSelection}
        onCourseMaterialRemove={removeCourseMaterial}
        materialsLocked={preparingGenerate}
        onUnitQuiz={handleUnitQuiz}
        onCaseTeaching={handleCaseTeaching}
      />

      {/* ═══ Top-right pill (unchanged) ═══ */}
      <div
        ref={toolbarRef}
        className="fixed top-4 right-4 z-50 flex items-center gap-1 bg-white/60 dark:bg-gray-800/60 backdrop-blur-md px-2 py-1.5 rounded-full border border-gray-100/50 dark:border-gray-700/50 shadow-sm"
      >
        {/* Language Selector */}
        <LanguageSwitcher onOpen={() => setThemeOpen(false)} />

        <div className="w-[1px] h-4 bg-gray-200 dark:bg-gray-700" />

        {/* Theme Selector */}
        <div className="relative">
          <button
            onClick={() => {
              setThemeOpen(!themeOpen);
            }}
            className="p-2 rounded-full text-gray-400 dark:text-gray-500 hover:bg-white dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 hover:shadow-sm transition-all"
          >
            {theme === 'light' && <Sun className="w-4 h-4" />}
            {theme === 'dark' && <Moon className="w-4 h-4" />}
            {theme === 'system' && <Monitor className="w-4 h-4" />}
          </button>
          {themeOpen && (
            <div className="absolute top-full mt-2 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg overflow-hidden z-50 min-w-[140px]">
              <button
                onClick={() => {
                  setTheme('light');
                  setThemeOpen(false);
                }}
                className={cn(
                  'w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-2',
                  theme === 'light' &&
                    'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
                )}
              >
                <Sun className="w-4 h-4" />
                {t('settings.themeOptions.light')}
              </button>
              <button
                onClick={() => {
                  setTheme('dark');
                  setThemeOpen(false);
                }}
                className={cn(
                  'w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-2',
                  theme === 'dark' &&
                    'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
                )}
              >
                <Moon className="w-4 h-4" />
                {t('settings.themeOptions.dark')}
              </button>
              <button
                onClick={() => {
                  setTheme('system');
                  setThemeOpen(false);
                }}
                className={cn(
                  'w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-2',
                  theme === 'system' &&
                    'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
                )}
              >
                <Monitor className="w-4 h-4" />
                {t('settings.themeOptions.system')}
              </button>
            </div>
          )}
        </div>

        <div className="w-[1px] h-4 bg-gray-200 dark:bg-gray-700" />

        {/* Settings Button */}
        <div className="relative">
          <button
            onClick={() => setSettingsOpen(true)}
            className="p-2 rounded-full text-gray-400 dark:text-gray-500 hover:bg-white dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 hover:shadow-sm transition-all group"
          >
            <Settings className="w-4 h-4 group-hover:rotate-90 transition-transform duration-500" />
          </button>
        </div>
      </div>
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open);
          if (!open) setSettingsSection(undefined);
        }}
        initialSection={settingsSection}
      />

      {/* ═══ Background Decor ═══ */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div
          className="absolute top-0 left-1/4 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl animate-pulse"
          style={{ animationDuration: '4s' }}
        />
        <div
          className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-pulse"
          style={{ animationDuration: '6s' }}
        />
      </div>

      {/* ═══ Hero section: title + input (centered, wider) ═══ */}
      <motion.div
        initial={heroEnter({ opacity: 0, y: 20 })}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
        className={cn('relative z-20 w-full max-w-[800px] flex flex-col items-center mt-[10vh]')}
      >
        {/* ── Logo ── */}
        <div className="relative" data-pro-morph="lockup">
          <motion.img
            src="/logo-horizontal.png"
            alt="OpenMAIC"
            initial={heroEnter({ opacity: 0, scale: 0.9 })}
            animate={{ opacity: 1, scale: 1 }}
            transition={{
              delay: 0.1,
              type: 'spring',
              stiffness: 200,
              damping: 20,
            }}
            className="h-12 md:h-16 mb-2 -ml-2 md:-ml-3"
          />
          {workbenchEntryEnabled ? (
            <div
              className="absolute left-full top-0 ml-1.5 mt-[10px] md:ml-2 md:mt-[14px]"
              data-pro-morph="badge"
            >
              <ProBadge active={false} onToggle={enterWorkbench} />
            </div>
          ) : null}
        </div>

        {/* ── Slogan ── */}
        <motion.p
          initial={heroEnter({ opacity: 0 })}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.25 }}
          className="text-sm text-muted-foreground/60 mb-8"
        >
          {t('home.slogan')}
        </motion.p>

        {/* ── Unified input area ── */}
        <motion.div
          initial={heroEnter({ opacity: 0, scale: 0.97 })}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.35 }}
          className="w-full"
        >
          <div
            data-pro-morph="composer"
            className="w-full rounded-2xl border border-border/60 bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl shadow-xl shadow-black/[0.03] dark:shadow-black/20 transition-shadow focus-within:shadow-2xl focus-within:shadow-violet-500/[0.06]"
          >
            {/* ── Greeting + Profile + Agents ── */}
            <div className="relative z-20 flex items-start justify-between">
              <GreetingBar />
              <div className="pr-3 pt-3.5 shrink-0">
                <AgentBar />
              </div>
            </div>

            {/* Textarea */}
            <textarea
              ref={textareaRef}
              placeholder={t('upload.requirementPlaceholder')}
              className="w-full resize-none border-0 bg-transparent px-4 pt-1 pb-2 text-[13px] leading-relaxed placeholder:text-muted-foreground/40 focus:outline-none min-h-[140px] max-h-[300px]"
              value={form.requirement}
              onChange={(e) => updateForm('requirement', e.target.value)}
              onKeyDown={handleKeyDown}
              rows={4}
            />

            {/* Toolbar row */}
            <div className="px-3 pb-3 flex items-end gap-2">
              <div className="flex-1 min-w-0">
                <GenerationToolbar
                  courseMaterials={visibleMaterials}
                  onCourseMaterialsAdd={addCourseMaterials}
                  onCourseMaterialRemove={removeCourseMaterial}
                  onPdfError={setError}
                  materialsLocked={preparingGenerate}
                  selectedMaterialId={visibleSelectedMaterialId}
                  onSettingsOpen={(section) => {
                    setSettingsSection(section);
                    setSettingsOpen(true);
                  }}
                />
              </div>

              {/* Interactive mode toggle */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <InteractiveModeButton
                    pressed={form.interactiveMode}
                    label={t('toolbar.interactiveModeLabel')}
                    onPressedChange={(pressed) => updateForm('interactiveMode', pressed)}
                  />
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {t('toolbar.interactiveModeHint')}
                </TooltipContent>
              </Tooltip>

              {/* Voice input */}
              <SpeechButton
                size="md"
                onTranscription={(text) => {
                  setForm((prev) => {
                    const next = prev.requirement + (prev.requirement ? ' ' : '') + text;
                    updateRequirementCache(next);
                    return { ...prev, requirement: next };
                  });
                }}
              />

              {/* Send button */}
              <button
                data-composer-submit=""
                onClick={handleGenerate}
                disabled={!canGenerate || preparingGenerate}
                className={cn(
                  'shrink-0 h-8 rounded-lg flex items-center justify-center gap-1.5 transition-all px-3',
                  canGenerate && !preparingGenerate
                    ? 'bg-primary text-primary-foreground hover:opacity-90 shadow-sm cursor-pointer'
                    : 'bg-muted text-muted-foreground/40 cursor-not-allowed',
                )}
              >
                <span className="text-xs font-medium">
                  {preparingGenerate ? t('stage.generating') : t('toolbar.enterClassroom')}
                </span>
                {preparingGenerate ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <ArrowUp className="size-3.5" />
                )}
              </button>
            </div>
          </div>
        </motion.div>

        {showVocationalTestUi && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            className="mt-2 flex w-full justify-start px-1"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  role="switch"
                  aria-checked={form.vocationalTestMode}
                  onClick={() => updateForm('vocationalTestMode', !form.vocationalTestMode)}
                  className={cn(
                    'inline-flex h-7 items-center gap-2 rounded-full border px-2.5 text-[11px] font-medium transition-colors',
                    form.vocationalTestMode
                      ? 'border-cyan-400/70 bg-cyan-50 text-cyan-700 shadow-[0_0_10px_rgba(6,182,212,0.16)] dark:bg-cyan-950/40 dark:text-cyan-300'
                      : 'border-border/70 bg-background/70 text-muted-foreground hover:border-cyan-300/60 hover:text-cyan-700 dark:hover:text-cyan-300',
                  )}
                >
                  <span className="rounded-full bg-cyan-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-normal text-cyan-700 dark:bg-cyan-900/45 dark:text-cyan-300">
                    测试功能
                  </span>
                  <Sparkles className="size-3.5" />
                  <span>职教任务</span>
                  <span
                    className={cn(
                      'relative h-3.5 w-6 rounded-full transition-colors',
                      form.vocationalTestMode ? 'bg-cyan-500' : 'bg-muted-foreground/25',
                    )}
                  >
                    <span
                      className={cn(
                        'absolute left-0.5 top-0.5 size-2.5 rounded-full bg-white transition-transform',
                        form.vocationalTestMode ? 'translate-x-2.5' : 'translate-x-0',
                      )}
                    />
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                从当前输入框提交职教实操训练测试
              </TooltipContent>
            </Tooltip>
          </motion.div>
        )}

        {/* ── Error ── */}
        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="mt-3 w-full p-3 bg-destructive/10 border border-destructive/20 rounded-lg"
            >
              <p className="text-sm text-destructive">{error}</p>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* ═══ Usage guide — the empty band to the right of the hero ═══ */}
      <HomeUsageGuide skipEnter={swapped} />

      {/* ═══ Recent classrooms — collapsible ═══ */}
      {/* The library action bar is always present after hydration: it carries
          the New-folder / import / search actions, so a brand-new user with
          zero courses and zero folders can still create the first folder or
          import. One stable action surface across root, folder, and empty. */}
      {hydrated && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
          className="relative z-10 mt-10 w-full max-w-6xl flex flex-col items-center"
        >
          {/* Trigger — divider-line with centered text. Fixed height keeps the
              bar geometrically stable when the New-folder action or the folder
              path appears/disappears (entering vs leaving a folder). */}
          <div className="group w-full flex items-center gap-4 h-9">
            <div className="flex-1 h-px bg-border/40 group-hover:bg-border/70 transition-colors" />
            <div className="shrink-0 flex items-center gap-3 text-[13px] text-muted-foreground/60 select-none">
              {/* Leaving a folder is its own gesture with its own label. It used
                  to hide inside the "recent" disclosure below, which made one
                  control mean two different things depending on where the user
                  stood — and left the folder exit looking like a collapse, so
                  nobody could tell which of the two had just eaten their prompt.
                  One control, one meaning. */}
              {currentFolderId && (
                <>
                  <button
                    type="button"
                    data-home-back-button=""
                    onClick={() => {
                      // The chapter picked inside the folder has no row in the
                      // root view this returns to, so a sentence naming it would
                      // be pointing at nothing. Reset first, then switch views.
                      resetHomeComposer();
                      setCurrentFolderId(undefined);
                    }}
                    className="flex items-center gap-1.5 hover:text-foreground/70 transition-colors cursor-pointer"
                  >
                    <ArrowLeft className="size-3.5" />
                    {t('classroom.backToHome')}
                  </button>
                  <span aria-hidden="true" className="w-px h-3.5 bg-border/60" />
                </>
              )}
              <button
                type="button"
                onClick={() => {
                  // A disclosure toggle, and nothing else. Collapsing the panel
                  // is not "going home": nothing unmounts and no route changes,
                  // so a reset here would silently eat a prompt for no reason.
                  persistRecentOpen(!recentOpen);
                }}
                className="flex items-center gap-2 hover:text-foreground/70 transition-colors cursor-pointer"
              >
                <Clock className="size-3.5" />
                {t('classroom.recentClassrooms')}
                {currentFolder && (
                  <>
                    <ChevronRight className="size-3 opacity-40" />
                    <span className="text-foreground/80 truncate max-w-[160px]">
                      {currentFolder.name}
                    </span>
                  </>
                )}
                <span className="text-[11px] tabular-nums opacity-60">
                  {currentFolder ? currentFolderClassrooms.length : coursewareClassrooms.length}
                </span>
                <motion.div
                  animate={{ rotate: recentOpen ? 180 : 0 }}
                  transition={{ duration: 0.3, ease: 'easeInOut' }}
                >
                  <ChevronDown className="size-3.5" />
                </motion.div>
              </button>

              {/* Search toggle — icon that expands into an input in place */}
              <AnimatePresence initial={false}>
                {!searchOpen ? (
                  <motion.button
                    key="search-icon"
                    ref={searchButtonRef}
                    type="button"
                    aria-label={t('classroom.searchAriaLabel')}
                    onClick={() => {
                      setSearchOpen(true);
                      if (!recentOpen) persistRecentOpen(true);
                      requestAnimationFrame(() => searchInputRef.current?.focus());
                    }}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.12, ease: 'easeOut' }}
                    className="flex items-center justify-center size-6 rounded-full text-muted-foreground/50 hover:text-foreground/70 hover:bg-muted/50 transition-colors cursor-pointer"
                  >
                    <Search className="size-3.5" />
                  </motion.button>
                ) : (
                  <motion.div
                    key="search-input"
                    initial={{ opacity: 0, width: 0 }}
                    animate={{ opacity: 1, width: 200 }}
                    exit={{ opacity: 0, width: 0 }}
                    transition={{ duration: 0.18, ease: [0.25, 0.1, 0.25, 1] }}
                    className="overflow-hidden"
                  >
                    <InputGroup
                      className={cn(
                        'h-7 text-[12px] rounded-full bg-muted/40 border-transparent shadow-none',
                        'transition-colors',
                        'hover:bg-muted/60',
                        'has-[[data-slot=input-group-control]:focus-visible]:bg-muted/60',
                        'has-[[data-slot=input-group-control]:focus-visible]:border-transparent',
                        'has-[[data-slot=input-group-control]:focus-visible]:ring-0',
                      )}
                    >
                      <InputGroupInput
                        ref={searchInputRef}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            e.preventDefault();
                            if (searchQuery) {
                              setSearchQuery('');
                            } else {
                              setSearchOpen(false);
                              requestAnimationFrame(() => searchButtonRef.current?.focus());
                            }
                          }
                        }}
                        onBlur={() => {
                          if (!searchQuery) {
                            setSearchOpen(false);
                          }
                        }}
                        placeholder={t('classroom.searchPlaceholder')}
                        aria-label={t('classroom.searchAriaLabel')}
                        className="h-7 pl-3 placeholder:text-muted-foreground/50"
                      />
                      {searchQuery && (
                        <InputGroupButton
                          size="icon-xs"
                          aria-label={t('classroom.clearSearch')}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            setSearchQuery('');
                            searchInputRef.current?.focus();
                          }}
                        >
                          <X />
                        </InputGroupButton>
                      )}
                    </InputGroup>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Narrow-viewport entry to the usage guide the wide card shows. */}
              <HomeUsageGuideEntry />

              <button
                onClick={triggerImport}
                disabled={importing}
                className="group/import grid grid-cols-[auto_0fr] hover:grid-cols-[auto_1fr] items-center gap-1 rounded-full px-1.5 py-0.5 text-[12px] text-muted-foreground/35 hover:text-muted-foreground/70 hover:bg-muted/50 transition-all duration-200 cursor-pointer"
              >
                <Upload className="size-3" />
                <span className="overflow-hidden opacity-0 group-hover/import:opacity-100 transition-opacity duration-200 whitespace-nowrap">
                  {t('import.classroom')}
                </span>
              </button>
              {PPTX_IMPORT_ENABLED && (
                <button
                  onClick={triggerPptxFileSelect}
                  disabled={pptxImporting}
                  className="group/import-pptx grid grid-cols-[auto_0fr] hover:grid-cols-[auto_1fr] items-center gap-1 rounded-full px-1.5 py-0.5 text-[12px] text-muted-foreground/35 hover:text-muted-foreground/70 hover:bg-muted/50 transition-all duration-200 cursor-pointer"
                >
                  <Presentation className="size-3" />
                  <span className="overflow-hidden opacity-0 group-hover/import-pptx:opacity-100 transition-opacity duration-200 whitespace-nowrap">
                    {t('import.pptx')}
                  </span>
                </button>
              )}
              {/* New folder — round icon button, matches the import/upload affordances. */}
              {!currentFolderId && !isSearching && (
                <button
                  type="button"
                  onClick={() => {
                    if (!recentOpen) persistRecentOpen(true);
                    setNewFolderOpen(true);
                  }}
                  aria-label={t('classroom.newFolderTitle')}
                  title={t('classroom.newFolderTitle')}
                  className="inline-flex items-center justify-center size-7 rounded-full bg-muted/40 text-muted-foreground ring-1 ring-border/50 hover:bg-muted hover:text-foreground hover:ring-border transition-[background-color,color,box-shadow] cursor-pointer"
                >
                  <FolderPlus className="size-3.5" />
                </button>
              )}
            </div>
            <div className="flex-1 h-px bg-border/40 group-hover:bg-border/70 transition-colors" />
          </div>

          {/* Expandable content */}
          <AnimatePresence>
            {recentOpen && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                className="w-full overflow-hidden"
              >
                {folders.length === 0 && coursewareClassrooms.length === 0 ? (
                  <div className="pt-8 pb-2 text-center text-[13px] text-muted-foreground/60">
                    {t('classroom.emptyLibraryHint')}
                  </div>
                ) : !isSearching && currentFolderId && currentFolderClassrooms.length === 0 ? (
                  // Empty folder: hint directly below the centered path bar.
                  <div className="pt-8 text-center">
                    <p className="text-[14px] text-muted-foreground">
                      {t('classroom.emptyFolderHint')}
                    </p>
                  </div>
                ) : isSearching && filteredClassrooms.length === 0 ? (
                  <div className="pt-8 pb-2 text-center text-[13px] text-muted-foreground/60">
                    {t('classroom.searchEmpty')}
                  </div>
                ) : (
                  <div className="pt-8">
                    {/* Breadcrumb — shown only while searching (the folder path
                        already lives in the centered header above). */}
                    {isSearching && (
                      <div className="mb-4 flex items-center gap-1.5 text-[13px] text-muted-foreground">
                        <button
                          type="button"
                          onClick={() => {
                            // Searching inside a folder leaves one the same way
                            // the folder breadcrumb does, so it resets on the
                            // same condition: a chapter filed there has no row
                            // in the root view this returns to. Exiting search
                            // at the root changes nothing the composer points
                            // at, so it must not cost the user their prompt.
                            if (currentFolderId) resetHomeComposer();
                            setCurrentFolderId(undefined);
                            setSearchQuery('');
                            setSearchOpen(false);
                          }}
                          className="hover:text-foreground transition-colors"
                        >
                          {t('classroom.backToHome')}
                        </button>
                        <ChevronRight className="size-3.5" />
                        <span className="text-foreground font-medium">
                          {t('classroom.searchResults')}
                        </span>
                        <span className="ml-1.5 text-[12px] text-muted-foreground tabular-nums">
                          ({filteredClassrooms.length})
                        </span>
                      </div>
                    )}

                    <AnimatePresence mode="wait">
                      <motion.div
                        key={
                          isSearching
                            ? 'search'
                            : currentFolderId
                              ? `folder-${currentFolderId}`
                              : 'root'
                        }
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        transition={{ duration: 0.2 }}
                        className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-5 gap-y-8"
                      >
                        {/* Root + non-search: render folder tiles first. */}
                        {!isSearching &&
                          currentFolderId === undefined &&
                          folders.map((folder, i) => (
                            <motion.div
                              key={folder.id}
                              initial={{ opacity: 0, y: 16 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ delay: i * 0.04, duration: 0.35, ease: 'easeOut' }}
                            >
                              <FolderCard
                                folder={folder}
                                courseCount={courseCountByFolder.get(folder.id) ?? 0}
                                coverSlides={coverSlidesByFolder.get(folder.id) ?? []}
                                onOpen={() => setCurrentFolderId(folder.id)}
                                onRename={handleRenameFolder(folder)}
                                onDelete={(mode) => confirmDeleteFolder(folder, mode)}
                                onDropCourse={(stageId) => handleMoveCourse(stageId, folder.id)}
                              />
                            </motion.div>
                          ))}

                        {/* Course tiles for the active view. */}
                        {visibleClassrooms.map((classroom, i) => (
                          <motion.div
                            key={classroom.id}
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: i * 0.04, duration: 0.35, ease: 'easeOut' }}
                          >
                            <ClassroomCard
                              classroom={classroom}
                              slide={thumbnails[classroom.id]}
                              formatDate={formatDate}
                              onDelete={handleDelete}
                              onRename={handleRename}
                              confirmingDelete={pendingDeleteId === classroom.id}
                              onConfirmDelete={() => confirmDelete(classroom.id)}
                              onCancelDelete={() => setPendingDeleteId(null)}
                              onClick={() => router.push(`/classroom/${classroom.id}`)}
                              overlay={
                                <>
                                  <MoveToFolderMenu
                                    folders={folders}
                                    currentFolderId={classroom.folderId}
                                    onMove={(folderId) => handleMoveCourse(classroom.id, folderId)}
                                    onCreateAndMove={handleCreateAndMove(classroom.id)}
                                  />
                                  {/* Search view: show the owning folder as a badge. */}
                                  {isSearching && classroom.folderId && (
                                    <span className="absolute bottom-2 left-2 z-10 inline-flex items-center gap-1 rounded-md bg-violet-500/80 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm pointer-events-none">
                                      <Folder className="size-2.5" />
                                      {folderNameById.get(classroom.folderId) ?? ''}
                                    </span>
                                  )}
                                </>
                              }
                            />
                          </motion.div>
                        ))}
                      </motion.div>
                    </AnimatePresence>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}

      {/* Folder dialogs — mounted at the top level so they are reachable even
          while the Recent section is collapsed or the course list is empty. */}
      <NewFolderDialog
        open={newFolderOpen}
        onOpenChange={(open) => {
          setNewFolderOpen(open);
          if (!open) setCreateAndMoveTarget(null);
        }}
        folders={folders}
        onCreate={handleCreateFolder}
      />

      {/* Footer — flows with content, at the very end */}
      <div className="mt-auto pt-12 pb-4 text-center text-xs text-muted-foreground/40">
        OpenMAIC Open Source Project
      </div>
    </div>
  );
}

// ─── Greeting Bar — avatar + "Hi, Name", click to edit in-place ────
const MAX_AVATAR_SIZE = 5 * 1024 * 1024;

function isCustomAvatar(src: string) {
  return src.startsWith('data:');
}

function GreetingBar() {
  const { t } = useI18n();
  const avatar = useUserProfileStore((s) => s.avatar);
  const nickname = useUserProfileStore((s) => s.nickname);
  const bio = useUserProfileStore((s) => s.bio);
  const setAvatar = useUserProfileStore((s) => s.setAvatar);
  const setNickname = useUserProfileStore((s) => s.setNickname);
  const setBio = useUserProfileStore((s) => s.setBio);

  const [open, setOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const displayName = nickname || t('profile.defaultNickname');

  // Click-outside to collapse
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setEditingName(false);
        setAvatarPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const startEditName = () => {
    setNameDraft(nickname);
    setEditingName(true);
    setTimeout(() => nameInputRef.current?.focus(), 50);
  };

  const commitName = () => {
    setNickname(nameDraft.trim());
    setEditingName(false);
  };

  const handleAvatarUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_AVATAR_SIZE) {
      toast.error(t('profile.fileTooLarge'));
      return;
    }
    if (!file.type.startsWith('image/')) {
      toast.error(t('profile.invalidFileType'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new window.Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext('2d')!;
        const scale = Math.max(128 / img.width, 128 / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (128 - w) / 2, (128 - h) / 2, w, h);
        setAvatar(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  return (
    <div ref={containerRef} className="relative pl-4 pr-2 pt-3.5 pb-1 w-auto">
      <input
        ref={avatarInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleAvatarUpload}
      />

      {/* ── Collapsed pill (always in flow) ── */}
      {!open && (
        <div
          className="flex items-center gap-2.5 cursor-pointer transition-all duration-200 group rounded-full px-2.5 py-1.5 border border-border/50 text-muted-foreground/70 hover:text-foreground hover:bg-muted/60 active:scale-[0.97]"
          onClick={() => setOpen(true)}
        >
          <div className="shrink-0 relative">
            <div className="size-8 rounded-full overflow-hidden ring-[1.5px] ring-border/30 group-hover:ring-violet-400/60 dark:group-hover:ring-violet-400/40 transition-all duration-300">
              <img src={avatar} alt="" className="size-full object-cover" />
            </div>
            <div className="absolute -bottom-0.5 -right-0.5 size-3.5 rounded-full bg-white dark:bg-slate-800 border border-border/40 flex items-center justify-center opacity-60 group-hover:opacity-100 transition-opacity">
              <Pencil className="size-[7px] text-muted-foreground/70" />
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="leading-none select-none flex items-center gap-1">
                  <span className="text-[13px] font-semibold text-foreground/85 group-hover:text-foreground transition-colors">
                    {t('home.greetingWithName', { name: displayName })}
                  </span>
                  <ChevronDown className="size-3 text-muted-foreground/30 group-hover:text-muted-foreground/60 transition-colors shrink-0" />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                {t('profile.editTooltip')}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      )}

      {/* ── Expanded panel (absolute, floating) ── */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
            className="absolute left-4 top-3.5 z-50 w-64"
          >
            <div className="rounded-2xl bg-white/95 dark:bg-slate-800/95 backdrop-blur-sm ring-1 ring-black/[0.04] dark:ring-white/[0.06] shadow-[0_1px_8px_-2px_rgba(0,0,0,0.06)] dark:shadow-[0_1px_8px_-2px_rgba(0,0,0,0.3)] px-2.5 py-2">
              {/* ── Row: avatar + name ── */}
              <div
                className="flex items-center gap-2.5 cursor-pointer transition-all duration-200"
                onClick={() => {
                  setOpen(false);
                  setEditingName(false);
                  setAvatarPickerOpen(false);
                }}
              >
                {/* Avatar */}
                <div
                  className="shrink-0 relative cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    setAvatarPickerOpen(!avatarPickerOpen);
                  }}
                >
                  <div className="size-8 rounded-full overflow-hidden ring-[1.5px] ring-violet-300/70 dark:ring-violet-500/40 transition-all duration-300">
                    <img src={avatar} alt="" className="size-full object-cover" />
                  </div>
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className="absolute -bottom-0.5 -right-0.5 size-3.5 rounded-full bg-white dark:bg-slate-800 border border-border/60 flex items-center justify-center"
                  >
                    <ChevronDown
                      className={cn(
                        'size-2 text-muted-foreground/70 transition-transform duration-200',
                        avatarPickerOpen && 'rotate-180',
                      )}
                    />
                  </motion.div>
                </div>

                {/* Text */}
                <div className="flex-1 min-w-0">
                  {editingName ? (
                    <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                      <input
                        ref={nameInputRef}
                        value={nameDraft}
                        onChange={(e) => setNameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitName();
                          if (e.key === 'Escape') {
                            setEditingName(false);
                          }
                        }}
                        onBlur={commitName}
                        maxLength={20}
                        placeholder={t('profile.defaultNickname')}
                        className="flex-1 min-w-0 h-6 bg-transparent border-b border-border/80 text-[13px] font-semibold text-foreground outline-none placeholder:text-muted-foreground/40"
                      />
                      <button
                        onClick={commitName}
                        className="shrink-0 size-5 rounded flex items-center justify-center text-violet-500 hover:bg-violet-100 dark:hover:bg-violet-900/30"
                      >
                        <Check className="size-3" />
                      </button>
                    </div>
                  ) : (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        startEditName();
                      }}
                      className="group/name inline-flex items-center gap-1 cursor-pointer"
                    >
                      <span className="text-[13px] font-semibold text-foreground/85 group-hover/name:text-foreground transition-colors">
                        {displayName}
                      </span>
                      <Pencil className="size-2.5 text-muted-foreground/30 opacity-0 group-hover/name:opacity-100 transition-opacity" />
                    </span>
                  )}
                </div>

                {/* Collapse arrow */}
                <motion.div
                  initial={{ opacity: 0, y: -2 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="shrink-0 size-6 rounded-full flex items-center justify-center hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
                >
                  <ChevronUp className="size-3.5 text-muted-foreground/50" />
                </motion.div>
              </div>

              {/* ── Expandable content ── */}
              <div className="pt-2" onClick={(e) => e.stopPropagation()}>
                {/* Avatar picker */}
                <AnimatePresence>
                  {avatarPickerOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.15, ease: 'easeInOut' }}
                      className="overflow-hidden"
                    >
                      <div className="p-1 pb-2.5 flex items-center gap-1.5 flex-wrap">
                        {AVATAR_OPTIONS.map((url) => (
                          <button
                            key={url}
                            onClick={() => setAvatar(url)}
                            className={cn(
                              'size-7 rounded-full overflow-hidden bg-gray-50 dark:bg-gray-800 cursor-pointer transition-all duration-150',
                              'hover:scale-110 active:scale-95',
                              avatar === url
                                ? 'ring-2 ring-violet-400 dark:ring-violet-500 ring-offset-0'
                                : 'hover:ring-1 hover:ring-muted-foreground/30',
                            )}
                          >
                            <img src={url} alt="" className="size-full" />
                          </button>
                        ))}
                        <label
                          className={cn(
                            'size-7 rounded-full flex items-center justify-center cursor-pointer transition-all duration-150 border border-dashed',
                            'hover:scale-110 active:scale-95',
                            isCustomAvatar(avatar)
                              ? 'ring-2 ring-violet-400 dark:ring-violet-500 ring-offset-0 border-violet-300 dark:border-violet-600 bg-violet-50 dark:bg-violet-900/30'
                              : 'border-muted-foreground/30 text-muted-foreground/50 hover:border-muted-foreground/50',
                          )}
                          onClick={() => avatarInputRef.current?.click()}
                          title={t('profile.uploadAvatar')}
                        >
                          <ImagePlus className="size-3" />
                        </label>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Bio */}
                <UITextarea
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  placeholder={t('profile.bioPlaceholder')}
                  maxLength={200}
                  rows={2}
                  className="resize-none border-border/40 bg-transparent min-h-[72px] !text-[13px] !leading-relaxed placeholder:!text-[11px] placeholder:!leading-relaxed focus-visible:ring-1 focus-visible:ring-border/60"
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Classroom Card — clean, minimal style ──────────────────────
function ClassroomCard({
  classroom,
  slide,
  formatDate,
  overlay,
  onDelete,
  onRename,
  confirmingDelete,
  onConfirmDelete,
  onCancelDelete,
  onClick,
}: {
  classroom: StageListItem;
  slide?: Slide;
  formatDate: (ts: number) => string;
  /** Extra absolutely-positioned layers over the thumbnail (move menu, badges). */
  overlay?: React.ReactNode;
  onDelete: (id: string, e: React.MouseEvent) => void;
  onRename: (id: string, newName: string) => void;
  confirmingDelete: boolean;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onClick: () => void;
}) {
  const { t } = useI18n();
  const thumbRef = useRef<HTMLDivElement>(null);
  const [thumbWidth, setThumbWidth] = useState(0);
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = thumbRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setThumbWidth(Math.round(entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (editing) nameInputRef.current?.focus();
  }, [editing]);

  const isTaskEngineMode = classroom.taskEngineMode === true;
  const showModeBadge = classroom.interactiveMode || isTaskEngineMode;
  const ModeBadgeIcon = isTaskEngineMode ? Sparkles : Atom;
  const modeBadgeLabel = isTaskEngineMode ? 'Vocational Mode' : t('toolbar.interactiveModeLabel');

  const startRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setNameDraft(classroom.name);
    setEditing(true);
  };

  const commitRename = () => {
    if (!editing) return;
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== classroom.name) {
      onRename(classroom.id, trimmed);
    }
    setEditing(false);
  };

  return (
    <div
      className="group cursor-pointer"
      onClick={confirmingDelete ? undefined : onClick}
      draggable={!confirmingDelete && !editing}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/stage-id', classroom.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={() => {
        // Notify folder cards to clear any lingering drop highlight (Escape-
        // cancelled drags may not fire dragleave on every target).
        window.dispatchEvent(new CustomEvent('course-drag-end'));
      }}
    >
      {/* Thumbnail — large radius, no border, subtle bg */}
      <div
        ref={thumbRef}
        className="relative w-full aspect-[16/9] rounded-2xl bg-slate-100 dark:bg-slate-800/80 overflow-hidden transition-transform duration-200 group-hover:scale-[1.02]"
      >
        {slide && thumbWidth > 0 ? (
          <SlideThumbnail
            slide={slide}
            size={thumbWidth}
            viewportSize={slide.viewportSize ?? 1000}
            viewportRatio={slide.viewportRatio ?? 0.5625}
          />
        ) : !slide ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="size-12 rounded-2xl bg-gradient-to-br from-violet-100 to-blue-100 dark:from-violet-900/30 dark:to-blue-900/30 flex items-center justify-center">
              <span className="text-xl opacity-50">📄</span>
            </div>
          </div>
        ) : null}

        {showModeBadge && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                aria-label={modeBadgeLabel}
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  'absolute bottom-2 left-2 inline-flex items-center justify-center size-5 rounded-full bg-white/70 dark:bg-slate-900/60 backdrop-blur-sm shadow-sm z-10',
                  isTaskEngineMode
                    ? 'text-amber-600 dark:text-amber-300 ring-1 ring-amber-500/35'
                    : 'text-cyan-600 dark:text-cyan-300 ring-1 ring-cyan-500/30',
                )}
              >
                <ModeBadgeIcon className="size-3" />
              </span>
            </TooltipTrigger>
            {/* Negative sideOffset compensates for the global Tooltip Arrow's
                rotate-45 bounding box, which Radix reserves as spacing. */}
            <TooltipContent
              side="top"
              align="start"
              sideOffset={-4}
              collisionPadding={0}
              className="text-xs"
            >
              {modeBadgeLabel}
            </TooltipContent>
          </Tooltip>
        )}

        {/* Delete — top-right, only on hover */}
        <AnimatePresence>
          {!confirmingDelete && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <Button
                size="icon"
                variant="ghost"
                className="absolute top-2 right-2 size-7 opacity-0 group-hover:opacity-100 transition-opacity bg-black/30 hover:bg-destructive/80 text-white hover:text-white backdrop-blur-sm rounded-full"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(classroom.id, e);
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="absolute top-2 right-11 size-7 opacity-0 group-hover:opacity-100 transition-opacity bg-black/30 hover:bg-black/50 text-white hover:text-white backdrop-blur-sm rounded-full"
                onClick={startRename}
              >
                <Pencil className="size-3.5" />
              </Button>
              {overlay}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Inline delete confirmation overlay */}
        <AnimatePresence>
          {confirmingDelete && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/50 backdrop-blur-[6px]"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="text-[13px] font-medium text-white/90">
                {t('classroom.deleteConfirmTitle')}?
              </span>
              <div className="flex gap-2">
                <button
                  className="px-3.5 py-1 rounded-lg text-[12px] font-medium bg-white/15 text-white/80 hover:bg-white/25 backdrop-blur-sm transition-colors"
                  onClick={onCancelDelete}
                >
                  {t('common.cancel')}
                </button>
                <button
                  className="px-3.5 py-1 rounded-lg text-[12px] font-medium bg-red-500/90 text-white hover:bg-red-500 transition-colors"
                  onClick={onConfirmDelete}
                >
                  {t('classroom.delete')}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Info — outside the thumbnail */}
      <div className="mt-2.5 px-1 flex items-center gap-2">
        <span className="shrink-0 inline-flex items-center rounded-full bg-violet-100 dark:bg-violet-900/30 px-2 py-0.5 text-[11px] font-medium text-violet-600 dark:text-violet-400">
          {classroom.sceneCount} {t('classroom.slides')} · {formatDate(classroom.updatedAt)}
        </span>
        {editing ? (
          <div className="flex-1 min-w-0" onClick={(e) => e.stopPropagation()}>
            <input
              ref={nameInputRef}
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setEditing(false);
              }}
              onBlur={commitRename}
              maxLength={100}
              placeholder={t('classroom.renamePlaceholder')}
              className="w-full bg-transparent border-b border-violet-400/60 text-[15px] font-medium text-foreground/90 outline-none placeholder:text-muted-foreground/40"
            />
          </div>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <p
                className="font-medium text-[15px] truncate text-foreground/90 min-w-0 cursor-text"
                onDoubleClick={startRename}
              >
                {classroom.name}
              </p>
            </TooltipTrigger>
            <TooltipContent
              side="bottom"
              sideOffset={4}
              className="!max-w-[min(90vw,32rem)] break-words whitespace-normal"
            >
              <div className="flex items-center gap-1.5">
                <span className="break-all">{classroom.name}</span>
                <button
                  className="shrink-0 p-0.5 rounded hover:bg-foreground/10 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(classroom.name);
                    toast.success(t('classroom.nameCopied'));
                  }}
                >
                  <Copy className="size-3 opacity-60" />
                </button>
              </div>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

export default function Page() {
  return <HomePage />;
}

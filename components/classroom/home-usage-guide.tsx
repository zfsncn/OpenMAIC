'use client';

/**
 * Home usage guide — "three ways to start a lesson", pinned to the right of the
 * hero.
 *
 * The hero is a centred 800px column, so at wide viewports it leaves a band of
 * genuinely empty space on its right (measured on a 1514×886 window: 318px wide
 * × 500px tall — the height being just the hero's own height, since everything
 * below it is laid out after it). That band is where this card lives.
 *
 * Three constraints keep it from becoming a hazard:
 *
 *  1. `absolute`, never `fixed`. The page scrolls; a fixed card would stay put
 *     and float on top of the "recent classrooms" thumbnails.
 *  2. Gated at `min-[1440px]`. Because the hero is centred, the card's left edge
 *     sits at `W/2 + 400` and its right edge at `W - 32`, so it only fits while
 *     `w <= W/2 - 448`. Below 1440 a 256px card would land on the composer;
 *     instead a "?" entry appears in the recent-classrooms action row and opens
 *     the very same copy in a dialog, so the information is never simply
 *     absent for narrow windows.
 *  3. Height capped at 500px: the distance from the hero's top to the
 *     thumbnails. No shipped locale reaches the cap — it guards long ones.
 *
 * The vertical offset mirrors the page frame (`pt-16` on the root plus
 * `mt-[10vh]` on the hero) instead of wrapping the hero in an extra positioned
 * box, which would have re-indented the whole 200-line hero block for no
 * behavioural difference.
 */

import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { ChevronDown, CircleHelp, Info } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

/** Persisted like `recentClassroomsOpen`: a disclosure the user sets once. */
export const USAGE_GUIDE_OPEN_STORAGE_KEY = 'homeUsageGuideOpen';

/**
 * Order is the badge number; `id` is the i18n sub-key. The tints only tell the
 * three rows apart at a glance — they deliberately do not reuse the chapter
 * panel's button colours, since the steps and those buttons are not the same
 * set and implying a pairing would mislead.
 */
const USAGE_STEPS = [
  {
    id: 'noText',
    badge: 'bg-violet-500/10 text-violet-600 dark:bg-violet-400/15 dark:text-violet-300',
  },
  {
    id: 'withMaterial',
    badge: 'bg-amber-500/10 text-amber-600 dark:bg-amber-400/15 dark:text-amber-300',
  },
  {
    id: 'existing',
    badge: 'bg-teal-500/10 text-teal-600 dark:bg-teal-400/15 dark:text-teal-300',
  },
] as const;
/**
 * The copy itself, shared by the wide card and the narrow-screen dialog so the
 * two can never drift apart.
 *
 * Each sentence is keyed whole on purpose: splitting "click 【Enter classroom】"
 * into fragments would break word order in most of the twelve locales.
 */
function UsageGuideBody({ variant }: { variant: 'card' | 'dialog' }) {
  const { t } = useI18n();
  const wide = variant === 'dialog';
  return (
    <>
      <ol className={cn('flex flex-col', wide ? 'gap-4' : 'gap-3.5')}>
        {USAGE_STEPS.map((step, index) => (
          <li key={step.id} className="flex gap-2.5">
            <span
              className={cn(
                'mt-px inline-flex size-[18px] shrink-0 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums',
                step.badge,
              )}
            >
              {index + 1}
            </span>
            <div className="min-w-0">
              <p
                className={cn(
                  'font-medium leading-snug text-foreground/90',
                  wide ? 'text-[13px]' : 'text-[12px]',
                )}
              >
                {t(`home.usageGuide.steps.${step.id}.title`)}
              </p>
              <p
                className={cn(
                  'mt-0.5 leading-relaxed text-muted-foreground',
                  wide ? 'text-[12.5px]' : 'text-[11.5px]',
                )}
              >
                {t(`home.usageGuide.steps.${step.id}.desc`)}
              </p>
            </div>
          </li>
        ))}
      </ol>
      <p
        className={cn(
          'flex items-start gap-1.5 border-t border-border/50 pt-3 leading-relaxed text-muted-foreground/80',
          wide ? 'mt-4 text-[12px]' : 'mt-3.5 text-[11px]',
        )}
      >
        <Info className="mt-[2px] size-3 shrink-0 opacity-70" />
        <span>{t('home.usageGuide.apiKeyNote')}</span>
      </p>
    </>
  );
}

/**
 * The wide-viewport card. Widowed and orphaned content is not a concern here:
 * the card is a disclosure, so a collapsed header is a complete, legible state
 * rather than an empty box.
 */
export function HomeUsageGuide({ skipEnter = false }: { skipEnter?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);

  // Hydrate client-only state after mount (avoids SSR mismatch): the server has
  // no localStorage, so the first paint is always the open card.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(USAGE_GUIDE_OPEN_STORAGE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is not readable during render
      if (saved !== null) setOpen(saved !== 'false');
    } catch {
      /* localStorage unavailable */
    }
  }, []);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(USAGE_GUIDE_OPEN_STORAGE_KEY, String(next));
    } catch {
      /* ignore */
    }
  };

  return (
    <motion.aside
      data-home-usage-guide=""
      initial={skipEnter ? false : { opacity: 0, x: 8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: skipEnter ? 0 : 0.45, duration: 0.5, ease: 'easeOut' }}
      className={cn(
        'absolute end-8 top-[calc(4rem+10vh)] z-20',
        'hidden min-[1440px]:flex flex-col',
        'w-[min(280px,calc(50vw-464px))] max-h-[500px] overflow-y-auto',
        'rounded-2xl border border-border/60 bg-white/80 backdrop-blur-xl',
        'shadow-xl shadow-black/[0.03] dark:bg-slate-900/80 dark:shadow-black/20',
      )}
    >
      <div className="flex items-start justify-between gap-2 px-3.5 pt-3 pb-2">
        <h2 className="text-[13px] font-medium leading-tight text-foreground/90">
          {t('home.usageGuide.title')}
        </h2>
        <button
          type="button"
          data-home-usage-guide-toggle=""
          aria-expanded={open}
          aria-label={t(open ? 'home.usageGuide.collapseLabel' : 'home.usageGuide.expandLabel')}
          title={t(open ? 'home.usageGuide.collapseLabel' : 'home.usageGuide.expandLabel')}
          onClick={toggle}
          className="-me-1 -mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground/50 transition-colors hover:bg-muted/60 hover:text-foreground/70"
        >
          <ChevronDown
            className={cn('size-3.5 transition-transform duration-200', !open && '-rotate-90')}
          />
        </button>
      </div>

      {open && (
        <div className="px-3.5 pb-3.5">
          <UsageGuideBody variant="card" />
        </div>
      )}
    </motion.aside>
  );
}

/**
 * The narrow-viewport fallback: a "?" in the recent-classrooms action row that
 * opens the same copy in a dialog. It hides itself once the card is on screen,
 * so the two never both offer the same content.
 */
export function HomeUsageGuideEntry() {
  const { t } = useI18n();
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          data-home-usage-guide-entry=""
          aria-label={t('home.usageGuide.openLabel')}
          title={t('home.usageGuide.openLabel')}
          className="inline-flex size-6 items-center justify-center rounded-full text-muted-foreground/50 transition-colors hover:bg-muted/50 hover:text-foreground/70 min-[1440px]:hidden"
        >
          <CircleHelp className="size-3.5" />
        </button>
      </DialogTrigger>
      <DialogContent aria-describedby={undefined} className="max-w-[min(440px,90vw)] gap-4">
        <DialogHeader>
          <DialogTitle className="text-[15px] font-medium">
            {t('home.usageGuide.title')}
          </DialogTitle>
        </DialogHeader>
        <UsageGuideBody variant="dialog" />
      </DialogContent>
    </Dialog>
  );
}

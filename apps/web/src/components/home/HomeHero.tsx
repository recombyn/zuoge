import type { ReactNode } from 'react';
import { useRef, useState, memo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ZuogeWordmarkSvg,
  ZUOGE_WORDMARK_ASPECT,
  useCjkBrand,
} from '@/components/base/AppBrandWordmark';
import HomeAgentComposer, {
  type HomeAgentCategory,
  type HomeAgentComposerHandle,
  type HomeAgentSubmitPayload,
} from '@/components/home/HomeAgentComposer';

type Props = {
  onSubmit: (payload: HomeAgentSubmitPayload) => void;
};

/** Suggest chips under the home composer — label key → casePrompts key. */
const HERO_EXAMPLE_CHIPS = [
  {
    suggestKey: 'poster',
    chipKey: 'midAutumnPoster',
    category: 'poster' as HomeAgentCategory,
  },
  { suggestKey: 'ui', chipKey: 'uiApp', category: 'mobile' as HomeAgentCategory },
  {
    suggestKey: 'commerceDetail',
    chipKey: 'commerceDetailPage',
    category: 'website' as HomeAgentCategory,
  },
] as const;

/** Home hero — zh uses graphic 「左格」 + slogan; ja/en keep text slogan (Latin brand in chrome). */
function HomeHero({ onSubmit }: Props): ReactNode {
  const { t } = useTranslation();
  const cjk = useCjkBrand();
  const composerRef = useRef<HomeAgentComposerHandle | null>(null);
  const [category, setCategory] = useState<HomeAgentCategory>('poster');
  const lastDesignCategoryRef = useRef<HomeAgentCategory>('poster');

  const setCategorySafe = (next: HomeAgentCategory) => {
    if (next !== 'image' && next !== 'video') lastDesignCategoryRef.current = next;
    setCategory(next);
  };

  const onComposerCategoryChange = (next: HomeAgentCategory) => {
    if (next === 'image' || next === 'video') {
      setCategory(next);
      return;
    }
    setCategorySafe(lastDesignCategoryRef.current || 'poster');
  };

  const onExampleChip = (chipKey: string, nextCategory: HomeAgentCategory) => {
    setCategorySafe(nextCategory);
    // Wait a tick so category-driven mode reset doesn't clobber the filled prompt.
    queueMicrotask(() => {
      composerRef.current?.applyExampleChip(chipKey);
    });
  };

  const title = t('home.heroStartTitle');

  return (
    <section className="home-hero-chat relative mx-auto flex w-full max-w-[720px] flex-col items-center">
      <h1
        className="mb-8 flex items-baseline justify-center gap-1.5 text-center text-[clamp(1.5rem,4vw,1.875rem)] font-normal tracking-[-0.02em] text-[var(--ink)]"
        aria-label={t('home.heroStartTitleAria')}
      >
        {cjk ? (
          <span
            className="app-brand-wordmark-cjk inline-block shrink-0 self-center text-[var(--ink)]"
            style={{
              height: 'calc(1em - 6px)',
              width: `calc((1em - 6px) * ${ZUOGE_WORDMARK_ASPECT})`,
            }}
          >
            <ZuogeWordmarkSvg height="100%" variant="cjk" />
          </span>
        ) : null}
        <span>{title}</span>
      </h1>

      <div className="home-hero-chat__composer w-full">
        <HomeAgentComposer
          ref={composerRef}
          category={category}
          onCategoryChange={onComposerCategoryChange}
          onSubmit={onSubmit}
          className="!ring-0 focus-within:!ring-0"
        />
      </div>

      <div
        className="mt-4 flex w-full flex-wrap items-center justify-center gap-2.5"
        role="group"
        aria-label={t('home.examplesLabel')}
      >
        {HERO_EXAMPLE_CHIPS.map(({ suggestKey, chipKey, category: chipCategory }) => (
          <button
            key={suggestKey}
            type="button"
            className="rounded-full border border-[var(--line)] bg-[var(--surface)] px-4 py-1.5 text-[13px] leading-5 text-[var(--ink)] transition-colors hover:border-[var(--ink)]/25 hover:bg-[var(--accent-soft)]"
            onClick={() => onExampleChip(chipKey, chipCategory)}
          >
            {t(`home.heroSuggest.${suggestKey}`)}
          </button>
        ))}
      </div>
    </section>
  );
}

export default memo(HomeHero);

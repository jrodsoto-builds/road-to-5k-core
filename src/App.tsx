import {useEffect, useRef, useState} from 'react';
import type {ComponentRef} from 'react';
import {
  App as WearablesApp,
  Button,
  Page,
  ScrollView,
  TextColor,
  TextStyle,
  TextView,
} from '@wearables-ui-toolkit/mrbd';

type Screen = 'run' | 'cue' | 'ask' | 'squad';

const screens: Screen[] = ['run', 'cue', 'ask', 'squad'];

export default function App() {
  const [screen, setScreen] = useState<Screen>('run');
  const askButton = useRef<ComponentRef<typeof Button>>(null);

  useEffect(() => {
    const handleDpad = (event: KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
      setScreen(current => {
        const next = (screens.indexOf(current) + direction + screens.length) % screens.length;
        return screens[next];
      });
    };

    window.addEventListener('keydown', handleDpad);
    return () => {
      window.removeEventListener('keydown', handleDpad);
      window.speechSynthesis?.cancel();
    };
  }, []);

  useEffect(() => {
    if (screen === 'ask') askButton.current?.getElement()?.focus();
  }, [screen]);

  return (
    <WearablesApp>
      <Page headerText="Run Coach" enableSystemBarInset={false}>
        <ScrollView className={`coach-screen coach-screen--${screen}`} ariaLabel="Run coach" tabIndex={0} insetForHeader>
          <div className="scroll-content">
          <main aria-live="polite">
          {screen === 'run' && (
            <section className="run-view" aria-label="Current run">
              <TextView as="p" textStyle={TextStyle.LABEL_EMPHASIZED} textColor={TextColor.SECONDARY} className="eyebrow">PACE</TextView>
              <TextView as="p" textStyle={TextStyle.BODY2_EMPHASIZED} className="pace-number">5:45</TextView>
              <TextView as="p" textStyle={TextStyle.BODY2} className="pace-unit">/ km</TextView>
              <div className="run-stats">
                <div className="stat"><TextView as="p" textStyle={TextStyle.META1} className="stat-label">DISTANCE</TextView><TextView as="p" textStyle={TextStyle.BODY2_EMPHASIZED}>1.8 km</TextView></div>
                <div className="stat"><TextView as="p" textStyle={TextStyle.META1} className="stat-label">ELAPSED</TextView><TextView as="p" textStyle={TextStyle.BODY2_EMPHASIZED}>12:40</TextView></div>
              </div>
              <TextView as="p" textStyle={TextStyle.BODY2_EMPHASIZED} className="run-cue">WALK in 0:30</TextView>
            </section>
          )}

          {screen === 'cue' && (
            <section className="interval-cue" aria-label="Walk interval">
              <TextView as="p" textStyle={TextStyle.BODY2_EMPHASIZED} className="cue-title">WALK</TextView>
              <TextView as="p" textStyle={TextStyle.BODY2} className="cue-subtitle">1:00 — easy does it</TextView>
              <div className="progress-track" role="progressbar" aria-label="Walk interval progress" aria-valuemin={0} aria-valuemax={60} aria-valuenow={18}>
                <span />
              </div>
              <TextView as="p" textStyle={TextStyle.BODY2} className="breath-cue">Breathe in… out…</TextView>
            </section>
          )}

          {screen === 'ask' && (
            <section className="ask-view" aria-label="Ask Meta">
              <TextView as="p" textStyle={TextStyle.BODY2} className="question">“How far is the runner ahead?”</TextView>
              <TextView as="p" textStyle={TextStyle.BODY2_EMPHASIZED} className="answer">≈15 m</TextView>
              <TextView as="p" textStyle={TextStyle.BODY2} className="answer-detail">holding your pace</TextView>
              <Button
                ref={askButton}
                className="ask-button"
                title="Hear answer"
                onClick={() => {
                  if (!('speechSynthesis' in window)) return;
                  window.speechSynthesis.cancel();
                  window.speechSynthesis.speak(
                    new SpeechSynthesisUtterance('About 15 meters ahead, holding your pace.'),
                  );
                }}
              />
            </section>
          )}

          {screen === 'squad' && (
            <section className="squad-view" aria-label="Squad count">
              <TextView as="p" textStyle={TextStyle.LABEL_EMPHASIZED} textColor={TextColor.SECONDARY} className="eyebrow">PASSED YOU</TextView>
              <TextView as="p" textStyle={TextStyle.BODY2_EMPHASIZED} className="squad-count">3</TextView>
              <TextView as="p" textStyle={TextStyle.BODY2} className="squad-detail">in your age group: 2</TextView>
              <TextView as="p" textStyle={TextStyle.META2} className="vision-note">vision estimates</TextView>
            </section>
          )}
          <div className="screen-position" aria-hidden="true">{screens.indexOf(screen) + 1} / 4</div>
          </main>
          </div>
        </ScrollView>
      </Page>
    </WearablesApp>
  );
}

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
import {countPassersby, getRunnerDistance} from './tools';

type Screen = 'run' | 'cue' | 'ask' | 'squad';
type CoachStatus = 'idle' | 'loading' | 'error';

const screens: Screen[] = ['run', 'cue', 'ask', 'squad'];
const questions = [
  'How far is the runner ahead of me?',
  'How many people passed me, and how many are in my age group?',
  'Give me a steady pace cue.',
];

function screenFromLocation(): Screen {
  const route = window.location.hash.slice(2);
  return screens.includes(route as Screen) ? route as Screen : 'run';
}

function writeScreenRoute(next: Screen, replace = false) {
  const method = replace ? 'replaceState' : 'pushState';
  window.history[method]({}, '', `#/${next}`);
}

export default function App() {
  const [screen, setScreen] = useState<Screen>(() => {
    const initialScreen = screenFromLocation();
    writeScreenRoute(initialScreen, true);
    return initialScreen;
  });
  const [coachAnswer, setCoachAnswer] = useState<string | null>(null);
  const [coachStatus, setCoachStatus] = useState<CoachStatus>('idle');
  const [questionIndex, setQuestionIndex] = useState(0);
  const [squadCount] = useState(() => countPassersby());
  const requestInFlight = useRef(false);
  const askButton = useRef<ComponentRef<typeof Button>>(null);

  const navigateToScreen = (next: Screen) => {
    if (next === screen) return;
    writeScreenRoute(next);
    setScreen(next);
  };

  useEffect(() => {
    const restoreScreen = () => setScreen(screenFromLocation());
    window.addEventListener('popstate', restoreScreen);
    return () => window.removeEventListener('popstate', restoreScreen);
  }, []);

  const askCoach = async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setCoachStatus('loading');
    try {
      const question = questions[questionIndex];
      const response = await fetch('/api/coach', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          question,
          screen: 'ask',
          context: {
            question,
            pace: '5:45 / km',
            distance: '1.8 km',
            elapsed: '12:40',
          },
        }),
      });
      if (!response.ok) throw new Error('Coach request failed');
      const result: unknown = await response.json();
      if (typeof result !== 'object' || result === null) throw new Error('Invalid coach response');

      let answer: string;
      if ('text' in result && typeof result.text === 'string') {
        answer = result.text;
      } else if ('toolCalls' in result && Array.isArray(result.toolCalls) && result.toolCalls.length > 0) {
        const call: unknown = result.toolCalls[0];
        if (typeof call !== 'object' || call === null || !('id' in call) || typeof call.id !== 'string'
          || !('function' in call) || typeof call.function !== 'object' || call.function === null
          || !('name' in call.function) || typeof call.function.name !== 'string'
          || !('arguments' in call.function) || typeof call.function.arguments !== 'string') {
          throw new Error('Invalid tool call');
        }

        // Validate the serialized arguments even though the current local tools take no parameters.
        JSON.parse(call.function.arguments);
        const toolResult = call.function.name === 'getRunnerDistance'
          ? getRunnerDistance()
          : call.function.name === 'countPassersby'
            ? countPassersby()
            : (() => { throw new Error('Unknown coach tool'); })();

        const toolResponse = await fetch('/api/coach/tool-result', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({
            question,
            toolCallId: call.id,
            toolName: call.function.name,
            toolResult,
          }),
        });
        if (!toolResponse.ok) throw new Error('Coach tool result failed');
        const toolReply: unknown = await toolResponse.json();
        if (typeof toolReply !== 'object' || toolReply === null || !('text' in toolReply) || typeof toolReply.text !== 'string') {
          throw new Error('Invalid coach response');
        }
        answer = toolReply.text;
      } else {
        throw new Error('Invalid coach response');
      }

      setCoachAnswer(answer);
      setCoachStatus('idle');
    } catch {
      setCoachStatus('error');
    } finally {
      requestInFlight.current = false;
    }
  };

  useEffect(() => {
    const handleDpad = (event: KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      if (screen === 'ask' && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        if (!requestInFlight.current) {
          const direction = event.key === 'ArrowUp' ? -1 : 1;
          setQuestionIndex(current => (current + direction + questions.length) % questions.length);
          setCoachAnswer(null);
          setCoachStatus('idle');
        }
        return;
      }
      const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
      const next = (screens.indexOf(screen) + direction + screens.length) % screens.length;
      navigateToScreen(screens[next]);
    };

    window.addEventListener('keydown', handleDpad);
    return () => {
      window.removeEventListener('keydown', handleDpad);
      window.speechSynthesis?.cancel();
    };
  }, [screen]);

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
              <TextView as="p" textStyle={TextStyle.BODY2} className="question">“{questions[questionIndex]}”</TextView>
              {coachStatus === 'loading' && (
                <TextView as="p" textStyle={TextStyle.BODY2_EMPHASIZED} className="coach-status" role="status">Asking…</TextView>
              )}
              {coachStatus === 'error' && (
                <TextView as="p" textStyle={TextStyle.BODY2_EMPHASIZED} className="coach-status" role="alert">Couldn't reach the coach — try again</TextView>
              )}
              {coachAnswer !== null && (
                <TextView as="p" textStyle={TextStyle.BODY2_EMPHASIZED} className="answer">{coachAnswer}</TextView>
              )}
              <Button
                ref={askButton}
                className="ask-button"
                title="Ask Meta"
                onClick={askCoach}
              />
            </section>
          )}

          {screen === 'squad' && (
            <section className="squad-view" aria-label="Squad count">
              <TextView as="p" textStyle={TextStyle.LABEL_EMPHASIZED} textColor={TextColor.SECONDARY} className="eyebrow">PASSED YOU</TextView>
              <TextView as="p" textStyle={TextStyle.BODY2_EMPHASIZED} className="squad-count">{squadCount.passedYou}</TextView>
              <TextView as="p" textStyle={TextStyle.BODY2} className="squad-detail">in your age group: {squadCount.inYourAgeGroup}</TextView>
              <TextView as="p" textStyle={TextStyle.BODY2} className="vision-note">vision estimates</TextView>
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

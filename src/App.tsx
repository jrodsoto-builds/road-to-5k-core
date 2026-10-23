import {Fragment, useEffect, useRef, useState} from 'react';
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

type Exercise = {name: string | null; group: string | null; sets: string | number | null; reps: string | number | null; durationSec: string | number | null; side: 'each' | null; notes: string | null};
type Plan = {exercises: Exercise[]; instructions?: {text: string; exercises?: string[]; groups?: string[]}[]; sourceDate?: string | null; scheduleNotes?: string | null} | null;
type Screen = 'run' | 'cue' | 'ask' | 'squad' | 'today' | 'plan';
type CoachStatus = 'idle' | 'loading' | 'error';

const lensScreens: Screen[] = ['run', 'cue', 'ask', 'squad', 'today'];
const questions = [
  'How far is the runner ahead of me?',
  'How many people passed me, and how many are in my age group?',
  'Give me a steady pace cue.',
];

function screenFromLocation(): Screen {
  const route = window.location.hash.slice(2);
  return [...lensScreens, 'plan'].includes(route as Screen) ? route as Screen : 'run';
}

function writeScreenRoute(next: Screen, replace = false) {
  const method = replace ? 'replaceState' : 'pushState';
  window.history[method]({}, '', `#/${next}`);
}

function planSlotCount(exercises: Exercise[]) {
  const slots = new Set<string>();
  exercises.forEach((exercise, index) => slots.add(exercise.group ? `group:${exercise.group}` : `exercise:${index}`));
  return slots.size;
}

function FragmentRow({group, exercise, prescription, applies}: {group: string | null; exercise: Exercise; prescription: string; applies: boolean}) {
  return <Fragment>
    {group && <tr className="plan-group"><th colSpan={3}>{group}</th></tr>}
    <tr>
      <td>{exercise.name ?? '—'}</td>
      <td>{prescription}{applies && <span className="annotation"> · both legs</span>}{exercise.side === 'each' && !applies && <span> · each side</span>}</td>
      <td>{exercise.notes ?? '—'}</td>
    </tr>
  </Fragment>;
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
  const [plan, setPlan] = useState<Plan>(null);
  const [planState, setPlanState] = useState<'loading' | 'ready' | 'error'>('loading');
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

  useEffect(() => {
    if (screen !== 'plan' && screen !== 'today') return;
    let active = true;
    fetch('/api/plan/current').then(response => {
      if (!response.ok) throw new Error('Plan request failed');
      return response.json() as Promise<Plan>;
    }).then(value => {
      if (active) { setPlan(value); setPlanState('ready'); }
    }).catch(() => { if (active) setPlanState('error'); });
    return () => { active = false; };
  }, [screen]);

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
      const current = lensScreens.includes(screen) ? screen : 'run';
      const next = (lensScreens.indexOf(current) + direction + lensScreens.length) % lensScreens.length;
      navigateToScreen(lensScreens[next]);
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
          {screen === 'today' && (
            <section className="today-view" aria-label="Today's plan">
              <TextView as="p" textStyle={TextStyle.BODY2_EMPHASIZED} className="today-count">Today: {planState === 'ready' && plan ? planSlotCount(plan.exercises) : '—'} exercises</TextView>
              <TextView as="p" textStyle={TextStyle.BODY2} className="today-name">{planState === 'ready' ? plan?.exercises[0]?.name ?? 'No exercise listed' : planState === 'error' ? 'Plan unavailable' : 'Loading plan…'}</TextView>
            </section>
          )}
          {screen === 'plan' && (
            <section className="plan-view" aria-label="Physical therapy plan">
              <h1>PT plan</h1>
              {planState === 'loading' && <p>Loading plan…</p>}
              {planState === 'error' && <p role="alert">Couldn’t load the plan.</p>}
              {planState === 'ready' && !plan && <p>No saved plan yet.</p>}
              {plan && <>
                {(plan.instructions ?? []).map(instruction => <p className="pt-instruction" key={instruction.text}><strong>PT instructions (confirmed by you):</strong> {instruction.text}</p>)}
                <div className="plan-table-wrap"><table><thead><tr><th>Exercise</th><th>Prescription</th><th>Notes</th></tr></thead><tbody>
                  {plan.exercises.map((exercise, index) => {
                    const prev = index > 0 ? plan.exercises[index - 1].group : null;
                    const showGroup = Boolean(exercise.group && exercise.group !== prev);
                    const prescription = exercise.durationSec != null
                      ? `${exercise.reps ?? '—'} holds × ${exercise.durationSec} sec`
                      : exercise.sets != null || exercise.reps != null
                        ? `${exercise.sets ?? '—'} sets × ${exercise.reps ?? '—'} reps`
                        : '—';
                    const applies = (plan.instructions ?? []).some(instruction => instruction.exercises?.includes(exercise.name ?? '') || instruction.groups?.includes(exercise.group ?? ''));
                    return <FragmentRow key={`${index}-${exercise.name}`} group={showGroup ? exercise.group : null} exercise={exercise} prescription={prescription} applies={applies} />;
                  })}
                </tbody></table></div>
              </>}
            </section>
          )}
          {lensScreens.includes(screen) && <div className="screen-position" aria-hidden="true">{lensScreens.indexOf(screen) + 1} / 5</div>}
          </main>
          </div>
        </ScrollView>
      </Page>
    </WearablesApp>
  );
}

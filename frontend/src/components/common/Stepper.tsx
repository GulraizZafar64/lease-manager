/** Progress through a multi-step form: done steps show a tick, the current one is filled, a step with
    unresolved errors is marked. Choosing a step asks the form to go there (the form decides whether it may). */
export interface StepDef { key: string; label: string }

export function Stepper({ steps, current, reached, errorSteps, onSelect }: { steps: StepDef[]; current: string; reached: number; errorSteps: Set<string>; onSelect: (key: string) => void }) {
    const at = Math.max(0, steps.findIndex(s => s.key === current));
    return (
        <div className="stepper-wrap">
            <ol className="stepper" aria-label="Form steps">
                {steps.map((s, i) => {
                    const state = errorSteps.has(s.key) ? 'error' : i === at ? 'current' : i <= reached ? 'done' : 'todo';
                    return (
                        <li key={s.key} className={`step step-${state}${i === at ? ' is-current' : ''}${i <= Math.max(reached, at) ? ' is-reached' : ''}`}>
                            <button type="button" data-ft={s.key} data-step={s.key} aria-current={i === at ? 'step' : undefined} onClick={() => onSelect(s.key)}
                                aria-label={`Step ${i + 1} of ${steps.length}: ${s.label}${state === 'done' ? ', complete' : state === 'error' ? ', needs attention' : ''}`}>
                                <span className="step-n" aria-hidden="true">{state === 'done' ? <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5 9-10" /></svg> : state === 'error' ? '!' : i + 1}</span>
                                <span className="step-l">{s.label}</span>
                            </button>
                        </li>
                    );
                })}
            </ol>
            <p className="stepper-meta">Step {at + 1} of {steps.length}<b>{steps[at] ? steps[at].label : ''}</b></p>
        </div>
    );
}

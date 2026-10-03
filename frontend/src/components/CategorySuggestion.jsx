import React, { useEffect, useState } from 'react';
import { Sparkles, Wand2, X } from 'lucide-react';
import { predictCategoryDebounced } from '../services/ai';

/**
 * Suggests a category as the user types a transaction title.
 *
 * The engine is consulted on a debounce; a null result means "no opinion" and
 * renders nothing, so an offline, untrained or slow model never gets in the
 * way of manual entry. Accepting a suggestion writes it into the parent form
 * through `onSelect`; the model learns the confirmed pair when the transaction
 * is saved, so a correction next time trains it.
 *
 * `extraParams` carries amount/notes/transactionType so the anomaly detector
 * can run on the same request and flag a fat-fingered amount before save.
 */
export default function CategorySuggestion({ title, enabled = true, extraParams = {}, onSelect, currentCategory }) {
  const [result, setResult] = useState(null);
  // ``loading`` is derived from the request round-trip: the effect sets a
  // marker when it dispatches a prediction and the callback clears it. Keeping
  // it as state (rather than setting it from inside the effect body) means the
  // render reflects the answer as soon as it arrives.
  const [loading, setLoading] = useState(false);
  // Dismissal is keyed to the title that was dismissed, so a new keystroke
  // naturally re-offers the suggestion without an extra state-driven render.
  const [dismissedFor, setDismissedFor] = useState(null);
  const dismissed = dismissedFor === title;

  useEffect(() => {
    if (!enabled || !title || !title.trim()) {
      setResult(null);
      return undefined;
    }
    const params = { title, ...extraParams };
    // A per-run flag is all the cancellation this needs: when the effect tears
    // down (new keystroke, unmount) the flag flips and any in-flight callback is
    // ignored instead of writing a stale suggestion into the form.
    let finished = false;
    setLoading(true);
    const cancel = predictCategoryDebounced(params, (data) => {
      finished = true;
      setLoading(false);
      setResult(data);
    });
    return () => {
      cancel();
      if (!finished) setLoading(false);
    };
  }, [enabled, title, extraParams]);

  const candidates = Array.isArray(result?.candidates) && result.candidates.length
    ? result.candidates
    : (result?.category ? [{ category: result.category, confidence: result.confidence }] : []);

  const alternatives = candidates.slice(1).filter((c) => c.category && c.category !== candidates[0]?.category);

  if (!enabled || !candidates.length || dismissed) return null;

  const top = candidates[0];
  const alreadySelected = currentCategory && top.category === currentCategory && alternatives.length === 0;
  if (alreadySelected) return null;

  return (
    <div className="ai-suggestion">
      <div className="ai-suggestion-head">
        <span className="ai-suggestion-badge"><Wand2 size={13} /> AI</span>
        <span className="ai-suggestion-label">
          {loading ? 'Thinking…' : (
            <>
              Suggested <strong>{top.category}</strong>
              {Number(top.confidence) > 0 ? ` · ${Math.round(Number(top.confidence) * 100)}%` : ''}
            </>
          )}
        </span>
        {!loading && (
          <button type="button" className="icon-button tiny" onClick={() => setDismissedFor(title)} aria-label="Dismiss suggestion" title="Dismiss">
            <X size={14} />
          </button>
        )}
      </div>

      {!loading && (
        <div className="ai-suggestion-actions">
          <button
            type="button"
            className="button tiny primary"
            onClick={() => onSelect?.(top.category)}
          >
            <Sparkles size={13} /> Use {top.category}
          </button>
          {alternatives.map((alt) => (
            <button
              key={alt.category}
              type="button"
              className="button tiny ghost"
              title={`Confidence ${Math.round(Number(alt.confidence || 0) * 100)}%`}
              onClick={() => onSelect?.(alt.category)}
            >
              {alt.category} · {Math.round(Number(alt.confidence || 0) * 100)}%
            </button>
          ))}
        </div>
      )}

      {!loading && result?.anomaly && (
        <div className="ai-suggestion-anomaly">
          <strong>Unusual amount.</strong> {result.anomaly.message}
        </div>
      )}
    </div>
  );
}

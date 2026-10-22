import { Sparkles } from 'lucide-react';
import type { Question } from '../shared/types';

export function QuestionFields({ questions, answers, onChange, onSave }: {
  questions: Question[];
  answers: Record<string, string>;
  onChange: (id: string, text: string) => void;
  onSave: () => void;
}) {
  return <div className="questions">
    {questions.map((q, index) => {
      const recommended = !!q.recommendedAnswer && answers[q.id] === q.recommendedAnswer;
      return <div className="question" key={q.id}>
        <div className="question-label">
          <span className="question-index">{String(index + 1).padStart(2, '0')}</span>
          <label htmlFor={q.id}>{q.label}{q.required && <i>*</i>}</label>
        </div>
        <div className="question-input">
          {q.recommendedAnswer && <div className="answer-caption">
            <span className={recommended ? 'recommended-label' : 'edited-label'}>
              {recommended && <Sparkles size={12} />}{recommended ? '추천 답변' : '수정한 답변'}
            </span>
            {!recommended && <button className="text-button" type="button" onClick={() => onChange(q.id, q.recommendedAnswer!)}>추천 답변 적용</button>}
          </div>}
          <textarea id={q.id} value={answers[q.id] ?? ''} onChange={e => onChange(q.id, e.target.value)} onBlur={onSave} rows={index === 0 ? 4 : 3} placeholder={q.recommendedAnswer ? '필요한 내용을 수정해주세요.' : q.hint} />
        </div>
      </div>;
    })}
  </div>;
}

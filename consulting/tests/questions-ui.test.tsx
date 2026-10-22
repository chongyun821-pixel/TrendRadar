import { renderToStaticMarkup } from 'react-dom/server';
import { it, expect } from 'vitest';
import { QuestionFields } from '../src/QuestionFields';

const question = { id: 'goal', label: '목표는 무엇인가요?', hint: '목표 안내', required: true, recommendedAnswer: '가정: 작성 시간을 줄인다. 기준 수치는 확인 필요.' };
it('renders the saved recommendation as an editable value, with its assumption visible', () => {
  const html = renderToStaticMarkup(<QuestionFields questions={[question]} answers={{ goal: question.recommendedAnswer }} onChange={() => {}} onSave={() => {}} />);
  expect(html).toContain('추천 답변');
  expect(html).toMatch(/<textarea[^>]*>가정: 작성 시간을 줄인다. 기준 수치는 확인 필요.<\/textarea>/);
  expect(html).not.toContain('추천 답변 적용');
});
it('shows user edits and a restore action without replacing a deliberately empty value', () => {
  const edited = renderToStaticMarkup(<QuestionFields questions={[question]} answers={{ goal: '내가 수정한 목표' }} onChange={() => {}} onSave={() => {}} />);
  expect(edited).toContain('수정한 답변'); expect(edited).toContain('내가 수정한 목표'); expect(edited).toContain('추천 답변 적용');
  const cleared = renderToStaticMarkup(<QuestionFields questions={[question]} answers={{ goal: '' }} onChange={() => {}} onSave={() => {}} />);
  expect(cleared).toMatch(/<textarea[^>]*><\/textarea>/);
});

import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './approval-portal.css';

const money = value => `${Number(value || 0).toLocaleString('ru-RU')} ₸`;

function App() {
  const token = location.pathname.match(/^\/approve\/([a-f0-9]+)/)?.[1];
  const [approval, setApproval] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState('');

  useEffect(() => {
    if (!token) return;

    fetch(`/approvals-api/public/approvals/${token}`)
      .then(r => r.json())
      .then(j => {
        if (j.data) setApproval(j.data);
        else setError(j.error?.message || 'Ошибка');
      })
      .catch(() => setError('Не удалось загрузить согласование'));
  }, [token]);

  async function respond(decision) {
    setBusy(true);
    setError('');
    try {
      const r = await fetch(`/approvals-api/public/approvals/${token}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, comment })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error?.message || 'Ошибка');
      setApproval(prev => ({ ...prev, status: decision }));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <main className="ap">
        <div className="apCard">
          <h2>PROFI24KST</h2>
          <p className="bad">Некорректная ссылка согласования</p>
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="ap">
        <div className="apCard">
          <h2>PROFI24KST</h2>
          <p className="bad">{error}</p>
        </div>
      </main>
    );
  }

  if (!approval) {
    return (
      <main className="ap">
        <div className="apCard">Загрузка…</div>
      </main>
    );
  }

  const snapshot = approval.snapshot || {};

  if (approval.status !== 'PENDING') {
    const title = approval.status === 'APPROVED'
      ? '✓ Согласовано'
      : approval.status === 'DECLINED'
        ? 'Смета отклонена'
        : 'Ссылка недействительна';

    return (
      <main className="ap">
        <div className="apCard done">
          <h1>{title}</h1>
          <p>Заявка {snapshot.number}</p>
          {approval.status === 'APPROVED' && (
            <p>Спасибо. Сервисный центр получил ваше решение и может приступать к ремонту.</p>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="ap">
      <div className="apCard">
        <div className="brand">PROFI<span>24</span>KST</div>
        <small>Согласование ремонта · версия {approval.version}</small>
        <h1>{snapshot.number}</h1>
        <p><b>{snapshot.customer_name}</b></p>
        <p>{[snapshot.category, snapshot.brand, snapshot.model].filter(Boolean).join(' ')}</p>

        {snapshot.diagnosis && (
          <section>
            <label>Результат диагностики</label>
            <p>{snapshot.diagnosis}</p>
          </section>
        )}

        <section>
          <label>Работы</label>
          {(snapshot.works || []).length ? (snapshot.works || []).map((work, i) => (
            <div className="row" key={`work-${i}`}>
              <span>{work.name} × {work.qty}</span>
              <b>{money(Number(work.qty) * Number(work.unit_price))}</b>
            </div>
          )) : <p>Работы не указаны</p>}
        </section>

        {(snapshot.parts || []).length > 0 && (
          <section>
            <label>Запчасти</label>
            {snapshot.parts.map((part, i) => (
              <div className="row" key={`part-${i}`}>
                <span>{part.name} × {part.qty}</span>
                <b>{money(Number(part.qty) * Number(part.sale_price))}</b>
              </div>
            ))}
          </section>
        )}

        {Number(snapshot.discount_amount) > 0 && (
          <div className="row">
            <span>Скидка</span>
            <b>− {money(snapshot.discount_amount)}</b>
          </div>
        )}

        <div className="total">
          <span>Итого</span>
          <b>{money(approval.total)}</b>
        </div>

        <textarea
          placeholder="Комментарий сервисному центру (необязательно)"
          value={comment}
          onChange={e => setComment(e.target.value)}
        />

        <button disabled={busy} className="yes" onClick={() => respond('APPROVED')}>
          {busy ? 'Отправка…' : `Согласовать ${money(approval.total)}`}
        </button>
        <button disabled={busy} className="no" onClick={() => respond('DECLINED')}>
          Отказаться
        </button>

        <p className="legal">
          Нажимая «Согласовать», вы подтверждаете стоимость работ и запчастей по данной смете.
        </p>
      </div>
    </main>
  );
}

const root = document.getElementById('root');
if (root && location.pathname.startsWith('/approve/')) {
  createRoot(root).render(<App />);
}

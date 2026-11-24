// The playground page's own questions and messages, instead of prompt(), confirm() and alert(): those block the
// page and cannot be styled. One <dialog> in index.html (#ask-dialog) asks them; each function returns a promise.
//
// Escape, a click on the backdrop and Cancel all count as no: askText() gives null, confirmAction() false.

const dialog = document.querySelector('#ask-dialog');
const message = document.querySelector('#ask-message');
const input = document.querySelector('#ask-input');
const cancelButton = document.querySelector('#ask-cancel');
const confirmButton = document.querySelector('#ask-confirm');

// Cancel is no submit button: Enter in the text field submits the form with the first one, which must be the answer.
cancelButton.onclick = () => dialog.close();

/** Resolves the open question with the answer: true for the confirm button, false otherwise. */
let answer = null;

dialog.addEventListener('close', () => {
  const resolve = answer;

  answer = null;
  resolve?.(dialog.returnValue === 'confirm');
});

closeOnBackdropClick(dialog);

/**
 * Asks for a text, with defaultValue filled in and selected.
 *
 * @returns {Promise<string|null>} What was entered (as entered, not trimmed), or null.
 */
export async function askText(text, defaultValue = '', { confirmLabel = 'OK' } = {}) {
  input.value = defaultValue;

  return (await ask(text, { confirmLabel, withInput: true })) ? input.value : null;
}

/**
 * Asks to confirm something; danger makes the confirm button red, for what cannot be undone.
 *
 * @returns {Promise<boolean>}
 */
export function confirmAction(text, { confirmLabel = 'OK', danger = false } = {}) {
  return ask(text, { confirmLabel, danger });
}

/**
 * Tells something; the promise resolves when the dialog is closed.
 *
 * @returns {Promise<void>}
 */
export async function tell(text) {
  await ask(text, { confirmLabel: 'OK', withCancel: false });
}

function ask(text, { confirmLabel, withInput = false, withCancel = true, danger = false }) {
  // A question that is still open counts as no; the dialog stays open for the new one.
  answer?.(false);

  message.textContent = text;
  input.hidden = !withInput;
  cancelButton.hidden = !withCancel;
  confirmButton.textContent = confirmLabel;
  confirmButton.classList.toggle('danger', danger);
  dialog.returnValue = '';

  return new Promise((resolve) => {
    answer = resolve;

    if (!dialog.open) {
      dialog.showModal();
    }

    if (withInput) {
      input.focus();
      input.select();
    } else {
      confirmButton.focus();
    }
  });
}

/**
 * Fallback for browsers without closedby="any" support (e.g. Safari): a click on the backdrop closes the dialog.
 */
export function closeOnBackdropClick(target) {
  if ('closedBy' in HTMLDialogElement.prototype) {
    return;
  }

  target.addEventListener('click', (event) => {
    if (event.target !== target) {
      return;
    }

    const rect = target.getBoundingClientRect();
    const isDialogContent = rect.top <= event.clientY && event.clientY <= rect.top + rect.height
      && rect.left <= event.clientX && event.clientX <= rect.left + rect.width;

    if (!isDialogContent) {
      target.close();
    }
  });
}

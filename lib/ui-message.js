export function createUiMessage(element, { onChange } = {}) {
  if (!element) {
    return {
      showMessage() {},
      hideMessage() {},
    };
  }

  return {
    showMessage(text) {
      element.textContent = text;
      element.classList.remove("hidden");
      onChange?.();
    },
    hideMessage() {
      element.classList.add("hidden");
      onChange?.();
    },
  };
}

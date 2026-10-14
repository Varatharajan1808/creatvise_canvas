export interface Command {
  label: string;
  do(): void;
  undo(): void;
}

export class History {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  onChange: () => void = () => {};

  /** Run a command and record it. Pass applied=true if the change is already on screen (e.g. after a drag). */
  exec(cmd: Command, applied = false) {
    if (!applied) cmd.do();
    this.undoStack.push(cmd);
    this.redoStack.length = 0;
    this.onChange();
  }

  /** Clear all undo and redo history. */
  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.onChange();
  }

  undo() {
    const c = this.undoStack.pop();
    if (!c) return;
    c.undo();
    this.redoStack.push(c);
    this.onChange();
  }

  redo() {
    const c = this.redoStack.pop();
    if (!c) return;
    c.do();
    this.undoStack.push(c);
    this.onChange();
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
}

function createPreSendState() {
  return {
    current: null,
    set(kind, value) {
      if (!['photo', 'voice'].includes(kind)) {
        throw new Error('Invalid preview kind.');
      }
      this.current = { kind, status: 'preview', progress: 0, ...value };
      return this.current;
    },
    beginUpload() {
      if (!this.current) throw new Error('No preview is active.');
      this.current.status = 'uploading';
      this.current.progress = 0;
      return this.current;
    },
    progress(value) {
      if (!this.current || this.current.status !== 'uploading') {
        throw new Error('No upload is active.');
      }
      this.current.progress = Math.max(0, Math.min(100, Number(value) || 0));
      return this.current;
    },
    fail(error) {
      if (!this.current) throw new Error('No preview is active.');
      this.current.status = 'failed';
      this.current.error = String(error || 'Upload failed.');
      return this.current;
    },
    clear() {
      this.current = null;
      return null;
    }
  };
}

if (typeof module !== 'undefined') {
  module.exports = { createPreSendState };
}

// Preloaded into every test process (npm test --import): a developer's own
// PROTON_DRIVE_INDEX* settings must never make a test touch the real cache dir.
for (const k of Object.keys(process.env)) if (k.startsWith("PROTON_DRIVE_INDEX")) delete process.env[k];

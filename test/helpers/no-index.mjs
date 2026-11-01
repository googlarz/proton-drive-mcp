// Preloaded into every test process (npm test --import): a developer's own
// PROTON_DRIVE_INDEX* settings must never make a test touch the real cache dir.
// The same goes for the encrypted content index (PROTON_DRIVE_CONTENT_INDEX*) and its keychain service name.
for (const k of Object.keys(process.env)) if (k.startsWith("PROTON_DRIVE_INDEX") || k.startsWith("PROTON_DRIVE_CONTENT_INDEX") || k === "PROTON_DRIVE_KEYCHAIN_SERVICE") delete process.env[k];

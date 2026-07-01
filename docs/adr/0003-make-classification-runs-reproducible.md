# Make classification runs reproducible

Classification runs should produce stable proposals when rerun against the same product evidence and classification configuration. Because AI-backed classification can otherwise vary between runs, the system should constrain model output, use fixed candidate lists, and record the configuration snapshot used so reviewers can understand why proposals changed after evidence or configuration changes.

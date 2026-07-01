# Version classification configuration in the workspace

Classification configuration will be durable workspace configuration rather than SQLite-only operational state. Product Types, Product Attributes, Attribute Profiles, Attribute Mappings, and allowed values should be versioned with the workspace so store-specific classification behavior is portable, reviewable, and recoverable, while SQLite may cache or index that configuration for UI and classification speed.

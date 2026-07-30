# Hana SQLite projection

This slice proves that the compile-time Hana/`sqlite_orm` path preserves enum,
fixed-array, and vector values across SQLite bind/extract. BLOB fields are
decoded by element width, and malformed byte lengths are rejected instead of
silently changing values.

Run the repository gate:

```text
./shifu verify --full
```

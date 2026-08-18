"use client";

import {
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import type { TextFilterOption } from "@/lib/flight-filters";

type FilterComboboxProps = {
  label: string;
  ariaLabel: string;
  searchLabel: string;
  allLabel: string;
  value: string;
  options: FilterComboboxOption[];
  onChange: (value: string) => void;
  allValue?: string;
  className?: string;
  describedBy?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  sortOptions?: boolean;
};

export type FilterComboboxOption = TextFilterOption & {
  label?: string;
  searchText?: string;
};

type DisplayOption = TextFilterOption & {
  label: string;
  searchText?: string;
};

const fold = (value: string) => value.toLocaleLowerCase("en-US");
const compareLabels = (left: DisplayOption, right: DisplayOption) =>
  left.label.localeCompare(right.label, "en-US", {
    sensitivity: "base",
    numeric: true,
  }) ||
  left.label.localeCompare(right.label, "en-US", {
    sensitivity: "variant",
    numeric: true,
  });

export function FilterCombobox({
  label,
  ariaLabel,
  searchLabel,
  allLabel,
  value,
  options,
  onChange,
  allValue = "all",
  className,
  describedBy,
  inputRef: providedInputRef,
  sortOptions = true,
}: FilterComboboxProps) {
  const inputId = useId();
  const listboxId = `${inputId}-listbox`;
  const rootRef = useRef<HTMLDivElement>(null);
  const ownedInputRef = useRef<HTMLInputElement>(null);
  const inputRef = providedInputRef ?? ownedInputRef;
  const choices = useMemo<DisplayOption[]>(() => {
    const metadataChoices = options.map((option) => ({
      ...option,
      label: option.label ?? option.value,
    }));
    if (
      fold(value) !== fold(allValue) &&
      !metadataChoices.some((option) => fold(option.value) === fold(value))
    ) {
      metadataChoices.push({ value, label: value, available: false });
    }
    return [
      { value: allValue, label: allLabel, available: true },
      ...(sortOptions ? metadataChoices.toSorted(compareLabels) : metadataChoices),
    ];
  }, [allLabel, allValue, options, sortOptions, value]);
  const selectedOption = choices.find(
    (option) => fold(option.value) === fold(value),
  )!;
  const selectedValue = selectedOption.value;
  const selectedLabel = selectedOption.label;
  const [draft, setDraft] = useState({
    sourceValue: value,
    query: selectedLabel,
    editing: false,
  });
  const draftMatchesValue = draft.sourceValue === value;
  const query = draftMatchesValue ? draft.query : selectedLabel;
  const editing = draftMatchesValue ? draft.editing : false;
  const [open, setOpen] = useState(false);
  const [activeValue, setActiveValue] = useState<string | null>(selectedValue);

  const visibleOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("en-US");
    if (!editing || !normalizedQuery) return choices;
    return choices.filter((option) =>
      `${option.label} ${option.searchText ?? ""}`
        .toLocaleLowerCase("en-US")
        .includes(normalizedQuery),
    );
  }, [choices, editing, query]);
  const enabledOptions = visibleOptions.filter(
    (option) => option.available || option.value === selectedValue,
  );
  const resolvedActiveValue = enabledOptions.some(
    (option) => option.value === activeValue,
  )
    ? activeValue
    : enabledOptions[0]?.value ?? null;

  const resetSearch = () => {
    setDraft({ sourceValue: value, query: selectedLabel, editing: false });
    setActiveValue(selectedValue);
  };

  const close = () => {
    setOpen(false);
    resetSearch();
  };

  const selectOption = (option: DisplayOption) => {
    if (!option.available && option.value !== selectedValue) return;
    onChange(option.value);
    setDraft({
      sourceValue: option.value,
      query: option.label,
      editing: false,
    });
    setActiveValue(option.value);
    setOpen(false);
  };

  const moveActiveOption = (direction: 1 | -1) => {
    if (enabledOptions.length === 0) return;
    const currentIndex = enabledOptions.findIndex(
      (option) => option.value === resolvedActiveValue,
    );
    const nextIndex =
      currentIndex < 0
        ? direction === 1
          ? 0
          : enabledOptions.length - 1
        : (currentIndex + direction + enabledOptions.length) %
          enabledOptions.length;
    setActiveValue(enabledOptions[nextIndex].value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      moveActiveOption(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" && open) {
      event.preventDefault();
      setActiveValue(enabledOptions[0]?.value ?? null);
      return;
    }
    if (event.key === "End" && open) {
      event.preventDefault();
      setActiveValue(enabledOptions.at(-1)?.value ?? null);
      return;
    }
    if (event.key === "Enter" && open) {
      event.preventDefault();
      const activeOption = visibleOptions.find(
        (option) => option.value === resolvedActiveValue,
      );
      if (activeOption) selectOption(activeOption);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Tab") close();
  };

  return (
    <div
      className={`airport-select metadata-combobox${className ? ` ${className}` : ""}`}
      ref={rootRef}
      onBlur={() => {
        window.setTimeout(() => {
          if (!rootRef.current?.contains(document.activeElement)) close();
        }, 0);
      }}
    >
      <label htmlFor={inputId}>{label}</label>
      <div
        className="metadata-combobox-control"
        onPointerDown={(event) => {
          if ((event.target as Element).closest("button")) return;
          if (event.target !== inputRef.current) {
            event.preventDefault();
            inputRef.current?.focus();
            setOpen(true);
          }
        }}
      >
        <Search aria-hidden="true" size={15} />
        <input
          id={inputId}
          ref={inputRef}
          role="combobox"
          aria-label={ariaLabel}
          aria-describedby={describedBy}
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded={open}
          aria-activedescendant={
            open && resolvedActiveValue
              ? `${listboxId}-${encodeURIComponent(resolvedActiveValue)}`
              : undefined
          }
          autoComplete="off"
          spellCheck={false}
          value={query}
          onFocus={(event) => {
            setOpen(true);
            setDraft({
              sourceValue: value,
              query: selectedLabel,
              editing: false,
            });
            setActiveValue(selectedValue);
            event.currentTarget.select();
          }}
          onClick={() => setOpen(true)}
          onChange={(event) => {
            setDraft({
              sourceValue: value,
              query: event.target.value,
              editing: true,
            });
            setOpen(true);
          }}
          onKeyDown={handleKeyDown}
        />
        {(editing && query) || selectedValue !== allValue ? (
          <button
            type="button"
            className="metadata-combobox-clear"
            aria-label={
              editing
                ? `Clear ${searchLabel}`
                : `Clear ${label.toLocaleLowerCase("en-US")} filter`
            }
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              if (editing) {
                setDraft({ sourceValue: value, query: "", editing: true });
                setOpen(true);
                inputRef.current?.focus();
              } else {
                selectOption(choices[0]);
              }
            }}
          >
            <X aria-hidden="true" size={15} />
          </button>
        ) : (
          <ChevronDown
            className="metadata-combobox-chevron"
            aria-hidden="true"
            size={16}
          />
        )}
      </div>
      {open && (
        <div className="metadata-combobox-popup">
          {visibleOptions.length > 0 ? (
            <ul id={listboxId} role="listbox" aria-label={`${label} options`}>
              {visibleOptions.map((option) => {
                const selected = option.value === selectedValue;
                const disabled = !option.available && !selected;
                return (
                  <li
                    id={`${listboxId}-${encodeURIComponent(option.value)}`}
                    key={option.value}
                    role="option"
                    aria-selected={selected}
                    aria-disabled={disabled || undefined}
                    className={
                      option.value === resolvedActiveValue ? "active" : undefined
                    }
                    onPointerDown={(event) => event.preventDefault()}
                    onPointerEnter={() => {
                      if (!disabled) setActiveValue(option.value);
                    }}
                    onClick={() => selectOption(option)}
                  >
                    <span>
                      {option.label}
                      {!option.available ? " · unavailable" : ""}
                    </span>
                    {selected && <Check aria-hidden="true" size={15} />}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p role="status">No options match “{query.trim()}”</p>
          )}
        </div>
      )}
    </div>
  );
}

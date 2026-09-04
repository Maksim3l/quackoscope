"""The casing engine of contract section 1.1.

A canonical name is an ordered list of lowercase ASCII tokens. Casing is a join,
applied per target. This module implements the join, the acronym rendering
table, the getter/setter prefix conventions, the async convention and the
reserved word strategies, all read out of contract.yaml rather than hardcoded.

Field and parameter names are stored in contract.yaml already joined with the
frozen wire join (snake_case), so this module recovers their token list by
splitting on "_". That split is exact: the wire join is snake_case over
lowercase ASCII tokens, so splitting on "_" inverts it with no ambiguity.
"""

from __future__ import annotations

from contract_loader import ContractLintFailure


def tokens_of_wire_name(wire_name: str) -> list[str]:
    """Inverts the frozen snake_case wire join back to its token list."""
    return wire_name.split("_")


def render_token(token: str, target: dict, is_leading: bool) -> str:
    """Renders one token for one target, honouring the acronym table."""
    acronym_table = target["acronym_rendering"][
        "leading" if is_leading else "non_leading"
    ]
    if token in acronym_table:
        return acronym_table[token]
    join = target["join"]
    if join == "snake_case":
        return token
    if join == "camelCase":
        return token if is_leading else token[:1].upper() + token[1:]
    if join == "PascalCase":
        return token[:1].upper() + token[1:]
    raise ContractLintFailure(
        "casing_join_known",
        f"casing.targets[].join = {join!r}",
        "the known joins are snake_case, camelCase and PascalCase",
    )


def join_tokens(tokens: list[str], target: dict) -> str:
    """Applies a target's join to a token list. No prefix, async or reserved
    word handling; those are separate stages of build_symbol_name."""
    separator = "_" if target["join"] == "snake_case" else ""
    return separator.join(
        render_token(token, target, is_leading=(index == 0))
        for index, token in enumerate(tokens)
    )


def apply_getter_setter_prefix(tokens: list[str], kind: str, target: dict) -> list[str]:
    """casing.getter_prefix_semantics, applied by operation kind.

    strip_leading_get is a no-op when the token list does not begin with "get",
    which is why the getter [list, function, block, types] keeps its name in
    rust.
    """
    if kind == "getter":
        convention = target["getter_prefix"]
        if convention == "keep_get":
            return list(tokens)
        if convention == "strip_leading_get":
            return list(tokens[1:]) if tokens and tokens[0] == "get" else list(tokens)
        raise ContractLintFailure(
            "casing_getter_prefix_known",
            f"casing.targets[].getter_prefix = {convention!r}",
            "the known conventions are keep_get and strip_leading_get",
        )
    if kind == "setter":
        convention = target["setter_prefix"]
        if convention == "keep_set":
            return list(tokens)
        if convention == "strip_leading_set":
            return list(tokens[1:]) if tokens and tokens[0] == "set" else list(tokens)
        raise ContractLintFailure(
            "casing_setter_prefix_known",
            f"casing.targets[].setter_prefix = {convention!r}",
            "the known conventions are keep_set and strip_leading_set",
        )
    return list(tokens)


def apply_async_style(rendered_name: str, target: dict) -> str:
    """casing.targets[].async_style. Only suffix_async changes the identifier;
    the other conventions change the signature, not the name."""
    style = target["async_style"]
    if style == "suffix_async":
        return rendered_name + "Async"
    if style in ("none", "callback_or_future", "async_def", "async_fn"):
        return rendered_name
    raise ContractLintFailure(
        "casing_async_style_known",
        f"casing.targets[].async_style = {style!r}",
        "the known styles are none, callback_or_future, suffix_async, async_def "
        "and async_fn",
    )


def escape_reserved_word(rendered_name: str, source_wire_name: str, target: dict) -> str:
    """lints.reserved_word_escaped.

    The collision is detected on the WIRE name, which is what the lint text
    says; the strategy is then applied to the RENDERED name, because that is
    the identifier the target language actually sees.
    """
    if source_wire_name not in target["reserved_words"]:
        return rendered_name
    strategy = target["reserved_word_strategy"]
    if strategy == "suffix_underscore":
        return rendered_name + "_"
    if strategy == "prefix_at":
        return "@" + rendered_name
    if strategy == "prefix_raw_identifier":
        return "r#" + rendered_name
    raise ContractLintFailure(
        "reserved_word_escaped",
        f"casing.targets[].reserved_word_strategy = {strategy!r} for wire name "
        f"{source_wire_name!r}",
        "the known strategies are none, suffix_underscore, prefix_at and "
        "prefix_raw_identifier",
    )


def build_symbol_name(tokens: list[str], kind: str, target: dict, is_operation: bool) -> str:
    """The full pipeline: prefix convention, join, async convention, reserved
    word escape. is_operation gates the async convention, which
    casing.async_style_applies_to declares as all_operations, so events, types
    and fields never take it."""
    prefixed = apply_getter_setter_prefix(tokens, kind, target)
    source_wire_name = "_".join(prefixed)
    rendered = join_tokens(prefixed, target)
    if is_operation:
        rendered = apply_async_style(rendered, target)
    return escape_reserved_word(rendered, source_wire_name, target)


def operation_symbol_name(operation: dict, target_name: str, target: dict) -> tuple[str, str | None]:
    """Returns (symbol, naming_override_reason). A per-language override on the
    operation wins over the computed name and must carry a reason, which
    contract_loader has already enforced."""
    override = (operation.get("naming_overrides") or {}).get(target_name)
    if override:
        return override["symbol"], override["reason"]
    return (
        build_symbol_name(
            operation["tokens"], operation["kind"], target, is_operation=True
        ),
        None,
    )


def event_symbol_name(event: dict, target: dict) -> str:
    return build_symbol_name(event["tokens"], "event", target, is_operation=False)


def field_symbol_name(wire_field_name: str, target: dict) -> str:
    """A record field or an operation parameter."""
    return build_symbol_name(
        tokens_of_wire_name(wire_field_name), "field", target, is_operation=False
    )

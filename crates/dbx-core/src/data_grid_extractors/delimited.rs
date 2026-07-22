use super::{
    value_text, write_bytes, DataGridDsvOptions, DataGridExtractError, DataGridExtractErrorCode, DataGridQuotePolicy,
    ExtractContext,
};
use std::borrow::Cow;
use std::io::Write;

const MAX_SEPARATOR_CHARACTERS: usize = 8;
const MAX_NULL_TEXT_CHARACTERS: usize = 64;

pub(super) fn write_dsv(
    context: &ExtractContext<'_>,
    output: &mut dyn Write,
    options: &DataGridDsvOptions,
) -> Result<(), DataGridExtractError> {
    validate_dsv_options(options, true)?;
    let mut first_row = true;
    if options.include_column_header {
        write_dsv_row(
            output,
            context.selected_columns.iter().map(|column| Cow::Borrowed(column.display_name.as_str())),
            options,
            options.include_row_header.then(|| "#".to_string()),
        )?;
        first_row = false;
    }
    for (row_index, row) in context.request.rows.iter().enumerate() {
        if !first_row {
            write_bytes(output, options.row_separator.as_bytes())?;
        }
        write_dsv_row(
            output,
            context.selected_source_indexes.iter().map(|source_index| {
                let value = &row[*source_index];
                if value.is_null() {
                    Cow::Borrowed(options.null_text.as_str())
                } else {
                    value_text(value)
                }
            }),
            options,
            options.include_row_header.then(|| (row_index + 1).to_string()),
        )?;
        first_row = false;
    }
    Ok(())
}

fn write_dsv_row<'a>(
    output: &mut dyn Write,
    values: impl Iterator<Item = Cow<'a, str>>,
    options: &DataGridDsvOptions,
    row_header: Option<String>,
) -> Result<(), DataGridExtractError> {
    let mut first = true;
    if let Some(header) = row_header {
        write_dsv_field(output, &header, options)?;
        first = false;
    }
    for value in values {
        if !first {
            write_bytes(output, options.column_separator.as_bytes())?;
        }
        write_dsv_field(output, &value, options)?;
        first = false;
    }
    Ok(())
}

fn write_dsv_field(
    output: &mut dyn Write,
    value: &str,
    options: &DataGridDsvOptions,
) -> Result<(), DataGridExtractError> {
    let quote = options.quote;
    let should_quote = match options.quote_policy {
        DataGridQuotePolicy::Always => true,
        DataGridQuotePolicy::Never => false,
        DataGridQuotePolicy::Minimal => {
            value.contains(&options.column_separator)
                || value.contains(&options.row_separator)
                || value.contains(quote)
                || value.contains('\r')
                || value.contains('\n')
        }
    };
    if !should_quote {
        return write_bytes(output, value.as_bytes());
    }
    let mut quote_buffer = [0; 4];
    let quote_text = quote.encode_utf8(&mut quote_buffer);
    write_bytes(output, quote_text.as_bytes())?;
    let mut segments = value.split(quote);
    if let Some(first) = segments.next() {
        write_bytes(output, first.as_bytes())?;
    }
    for segment in segments {
        write_bytes(output, quote_text.as_bytes())?;
        write_bytes(output, quote_text.as_bytes())?;
        write_bytes(output, segment.as_bytes())?;
    }
    write_bytes(output, quote_text.as_bytes())
}

pub(super) fn write_one_row(context: &ExtractContext<'_>, output: &mut dyn Write) -> Result<(), DataGridExtractError> {
    let options = DataGridDsvOptions { column_separator: ",".to_string(), ..context.request.options.dsv.clone() };
    validate_dsv_options(&options, false)?;
    let values = context
        .request
        .rows
        .iter()
        .flat_map(|row| context.selected_source_indexes.iter().map(move |source_index| &row[*source_index]));
    let mut first = true;
    for value in values {
        if !first {
            write_bytes(output, options.column_separator.as_bytes())?;
        }
        let text = if value.is_null() { Cow::Borrowed(options.null_text.as_str()) } else { value_text(value) };
        write_dsv_field(output, &text, &options)?;
        first = false;
    }
    Ok(())
}

fn validate_dsv_options(options: &DataGridDsvOptions, uses_row_separator: bool) -> Result<(), DataGridExtractError> {
    if options.column_separator.is_empty() || (uses_row_separator && options.row_separator.is_empty()) {
        return Err(DataGridExtractError::new(
            DataGridExtractErrorCode::InvalidDsvConfiguration,
            "DSV column and row separators must not be empty.",
        ));
    }
    if options.column_separator.chars().count() > MAX_SEPARATOR_CHARACTERS
        || options.row_separator.chars().count() > MAX_SEPARATOR_CHARACTERS
        || options.null_text.chars().count() > MAX_NULL_TEXT_CHARACTERS
    {
        return Err(DataGridExtractError::new(
            DataGridExtractErrorCode::InvalidDsvConfiguration,
            "DSV separators may contain at most 8 characters and NULL text at most 64 characters.",
        ));
    }
    if uses_row_separator
        && (options.column_separator.contains(&options.row_separator)
            || options.row_separator.contains(&options.column_separator))
    {
        return Err(DataGridExtractError::new(
            DataGridExtractErrorCode::InvalidDsvConfiguration,
            "DSV column and row separators must not overlap.",
        ));
    }
    if options.quote.is_control()
        || options.column_separator.contains(options.quote)
        || (uses_row_separator && options.row_separator.contains(options.quote))
    {
        return Err(DataGridExtractError::new(
            DataGridExtractErrorCode::InvalidDsvConfiguration,
            "DSV quote must be a non-control character that is not part of a separator.",
        ));
    }
    Ok(())
}

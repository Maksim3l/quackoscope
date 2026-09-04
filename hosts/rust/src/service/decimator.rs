// Quackoscope host (Rust) -- service layer.
//
// Decimation is the host's job and it happens here, never in the frontend.
// subscribe_signal carries pixel_columns; every emitted frame has
// sample_count <= pixel_columns.

/// One decimated chunk, ready for transport::wire::encode_data_frame.
#[derive(Debug, Clone, Default)]
pub struct DecimatedChunk {
    /// 0 = raw, 1 = min_max_envelope (contract section 9, encodings).
    pub encoding: u8,
    pub sample_count: u32,
    /// encoding 0: `sample_count` values.
    /// encoding 1: `2 * sample_count` values, interleaved (min, max) per column.
    pub payload: Vec<f64>,
}

/// A chunk shorter than the plot width needs no thinning and goes out raw; a
/// longer one is folded into `pixel_columns` (min, max) pairs.
pub fn decimate(values: &[f64], pixel_columns: u32) -> DecimatedChunk {
    if values.is_empty() || pixel_columns == 0 {
        return DecimatedChunk::default();
    }

    if values.len() <= pixel_columns as usize {
        return DecimatedChunk {
            encoding: 0,
            sample_count: values.len() as u32,
            payload: values.to_vec(),
        };
    }

    let count = values.len();
    let columns = pixel_columns as usize;
    let mut payload = vec![0.0f64; columns * 2];

    for column in 0..columns {
        let begin = count * column / columns;
        let mut end = count * (column + 1) / columns;
        if end <= begin {
            end = begin + 1;
        }
        if end > count {
            end = count;
        }

        let mut lo = values[begin];
        let mut hi = values[begin];
        for value in &values[begin + 1..end] {
            if *value < lo {
                lo = *value;
            }
            if *value > hi {
                hi = *value;
            }
        }
        payload[column * 2] = lo;
        payload[column * 2 + 1] = hi;
    }

    DecimatedChunk {
        encoding: 1,
        sample_count: pixel_columns,
        payload,
    }
}

#[cfg(test)]
mod decimation_bounds {
    use super::decimate;

    #[test]
    fn a_chunk_no_longer_than_the_plot_width_goes_out_raw_and_unchanged() {
        let chunk = decimate(&[1.0, 2.0, 3.0], 8);
        assert_eq!(chunk.encoding, 0);
        assert_eq!(chunk.sample_count, 3);
        assert_eq!(chunk.payload, vec![1.0, 2.0, 3.0]);
    }

    #[test]
    fn a_longer_chunk_becomes_exactly_pixel_columns_min_max_pairs() {
        let values: Vec<f64> = (0..1000).map(|i| i as f64).collect();
        let chunk = decimate(&values, 4);
        assert_eq!(chunk.encoding, 1);
        assert_eq!(chunk.sample_count, 4);
        assert_eq!(chunk.payload.len(), 8);
        assert_eq!(chunk.payload[0], 0.0);
        assert_eq!(chunk.payload[1], 249.0);
        assert_eq!(chunk.payload[6], 750.0);
        assert_eq!(chunk.payload[7], 999.0);
    }
}

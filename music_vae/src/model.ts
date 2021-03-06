/**
 * @license
 * Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
// Use custom CheckpointLoader until quantization is added to tf.
import {CheckpointLoader, INoteSequence, data, tf} from '@magenta/core';
import {isNullOrUndefined} from 'util';

/**
 * A class for keeping track of the parameters of an affine transformation.
 *
 * @param kernel A 2-dimensional tensor with the kernel parameters.
 * @param bias A 1-dimensional tensor with the bias parameters.
 */
class LayerVars {
  kernel: tf.Tensor2D;
  bias: tf.Tensor1D;
  constructor(kernel: tf.Tensor2D, bias: tf.Tensor1D) {
    if (isNullOrUndefined(kernel)) {
      throw Error('`kernel` is undefined.');
    }
    if (isNullOrUndefined(bias)) {
      throw Error('`bias` is undefined.');
    }
    this.kernel = kernel;
    this.bias = bias;
  }
}

/**
 * Helper function to compute an affine transformation.
 *
 * @param vars `LayerVars` containing the `kernel` and `bias` of the
 * transformation.
 * @param inputs A batch of input vectors to transform.
 */
function dense(vars: LayerVars, inputs: tf.Tensor2D) {
  return inputs.matMul(vars.kernel).add(vars.bias) as tf.Tensor2D;
}

/**
 * Abstract Encoder class.
 */
abstract class Encoder {
  abstract zDims: number;
  abstract encode(sequence: tf.Tensor3D): tf.Tensor2D;
}

/**
 * A single-layer bidirectional LSTM encoder.
 */
class BidirectonalLstmEncoder extends Encoder {
  lstmFwVars: LayerVars;
  lstmBwVars: LayerVars;
  muVars: LayerVars;
  zDims: number;

  /**
   * `BidirectonalLstmEncoder` contructor.
   *
   * @param lstmFwVars The forward LSTM `LayerVars`.
   * @param lstmBwVars The backward LSTM `LayerVars`.
   * @param muVars (Optional) The `LayerVars` for projecting from the final
   * states of the bidirectional LSTM to the mean `mu` of the random variable,
   * `z`. The final states are returned directly if not provided.
   */
  constructor(
      lstmFwVars: LayerVars, lstmBwVars: LayerVars, muVars?: LayerVars) {
    super();
    this.lstmFwVars = lstmFwVars;
    this.lstmBwVars = lstmBwVars;
    this.muVars = muVars;
    this.zDims = muVars ? this.muVars.bias.shape[0] : null;
  }

  /**
   * Encodes a batch of sequences.
   * @param sequence The batch of sequences to be encoded.
   * @returns A batch of concatenated final LSTM states, or the `mu` if `muVars`
   * is known.
   */
  encode(sequence: tf.Tensor3D) {
    return tf.tidy(() => {
      const fwState = this.singleDirection(sequence, true);
      const bwState = this.singleDirection(sequence, false);
      const finalState = tf.concat([fwState[1], bwState[1]], 1);
      if (this.muVars) {
        return dense(this.muVars, finalState);
      } else {
        return finalState;
      }
    });
  }

  private singleDirection(inputs: tf.Tensor3D, fw: boolean) {
    const batchSize = inputs.shape[0];
    const length = inputs.shape[1];

    const lstmVars = fw ? this.lstmFwVars : this.lstmBwVars;
    let state: [tf.Tensor2D, tf.Tensor2D] = [
      tf.zeros([batchSize, lstmVars.bias.shape[0] / 4]),
      tf.zeros([batchSize, lstmVars.bias.shape[0] / 4])
    ];
    const forgetBias = tf.scalar(1.0);
    const lstm = (data: tf.Tensor2D, state: [tf.Tensor2D, tf.Tensor2D]) =>
        tf.basicLSTMCell(
            forgetBias, lstmVars.kernel, lstmVars.bias, data, state[0],
            state[1]);
    const splitInputs = tf.split(inputs, length, 1);
    for (const data of (fw ? splitInputs : splitInputs.reverse())) {
      state = lstm(data.squeeze([1]) as tf.Tensor2D, state);
    }
    return state;
  }
}

/**
 * A hierarchical encoder that uses the outputs from each level as the inputs
 * to the subsequent level.
 */
class HierarchicalEncoder extends Encoder {
  baseEncoders: Encoder[];
  numSteps: number[];
  muVars: LayerVars;
  zDims: number;

  /**
   * `HierarchicalEncoder` contructor.
   *
   * @param baseEncoders An list of `Encoder` objects to use for each.
   * @param numSteps A list containing the number of steps (outputs) for each
   * level of the hierarchy. This number should evenly divide the inputs for
   * each level. The final entry must always be `1`.
   * @param muVars The `LayerVars` for projecting from the final
   * states of the final level to the mean `mu` of the random variable, `z`.
   */
  constructor(baseEncoders: Encoder[], numSteps: number[], muVars: LayerVars) {
    super();
    this.baseEncoders = baseEncoders;
    this.numSteps = numSteps;
    this.muVars = muVars;
    this.zDims = this.muVars.bias.shape[0];
  }

  /**
   * Encodes a batch of sequences.
   * @param sequence The batch of sequences to be encoded.
   * @returns A batch of `mu` values.
   */
  encode(sequence: tf.Tensor3D) {
    return tf.tidy(() => {
      let inputs: tf.Tensor3D = sequence;

      for (let level = 0; level < this.baseEncoders.length; ++level) {
        const levelSteps = this.numSteps[level];
        const splitInputs = tf.split(inputs, levelSteps, 1);
        const embeddings: tf.Tensor2D[] = [];
        for (let step = 0; step < levelSteps; ++step) {
          embeddings.push(this.baseEncoders[level].encode(
              splitInputs[step] as tf.Tensor3D));
        }
        inputs = tf.stack(embeddings, 1) as tf.Tensor3D;
      }
      return dense(this.muVars, inputs.squeeze([1]));
    });
  }
}

/**
 * Helper function to create LSTM cells and initial states for decoders.
 *
 * @param z A batch of latent vectors to decode, sized `[batchSize, zDims]`.   *
 * @param lstmCellVars The `LayerVars` for each layer of the decoder LSTM.
 * @param zToInitStateVars The `LayerVars` for projecting from the latent
 * variable `z` to the initial states of the LSTM layers.
 * @returns An Object containing the LSTM cells and initial states.
 */
function initLstmCells(
    z: tf.Tensor2D, lstmCellVars: LayerVars[], zToInitStateVars: LayerVars) {
  const lstmCells: tf.LSTMCellFunc[] = [];
  const c: tf.Tensor2D[] = [];
  const h: tf.Tensor2D[] = [];
  const initialStates = tf.split(dense(zToInitStateVars, z).tanh(), 4, 1);
  for (let i = 0; i < lstmCellVars.length; ++i) {
    const lv = lstmCellVars[i];
    const forgetBias = tf.scalar(1.0);
    lstmCells.push(
        (data: tf.Tensor2D, c: tf.Tensor2D, h: tf.Tensor2D) =>
            tf.basicLSTMCell(forgetBias, lv.kernel, lv.bias, data, c, h));
    c.push(initialStates[i * 2] as tf.Tensor2D);
    h.push(initialStates[i * 2 + 1] as tf.Tensor2D);
  }
  return {'cell': lstmCells, 'c': c, 'h': h};
}

/**
 * Abstract Decoder class.
 */
abstract class Decoder {
  abstract outputDims: number;
  abstract zDims: number;

  abstract decode(
      z: tf.Tensor2D, length: number, initialInput?: tf.Tensor2D,
      temperature?: number): tf.Tensor3D;
}

/**
 * LSTM decoder with optional NADE output.
 */
class BaseDecoder extends Decoder {
  lstmCellVars: LayerVars[];
  zToInitStateVars: LayerVars;
  outputProjectVars: LayerVars;
  zDims: number;
  outputDims: number;
  nade: Nade;

  /**
   * `BaseDecoder` contructor.
   *
   * @param lstmCellVars The `LayerVars` for each layer of the decoder LSTM.
   * @param zToInitStateVars The `LayerVars` for projecting from the latent
   * variable `z` to the initial states of the LSTM layers.
   * @param outputProjectVars The `LayerVars` for projecting from the output
   * of the LSTM to the logits of the output categorical distrubtion
   * (if `nade` is null) or to bias values to use in the NADE (if `nade` is
   * not null).
   * @param nade (optional) A `Nade` to use for computing the output vectors at
   * each step. If not given, the final projection values are used as logits
   * for a categorical distribution.
   */
  constructor(
      lstmCellVars: LayerVars[], zToInitStateVars: LayerVars,
      outputProjectVars: LayerVars, nade?: Nade) {
    super();
    this.lstmCellVars = lstmCellVars;
    this.zToInitStateVars = zToInitStateVars;
    this.outputProjectVars = outputProjectVars;
    this.zDims = this.zToInitStateVars.kernel.shape[0];
    this.outputDims = (nade) ? nade.numDims : outputProjectVars.bias.shape[0];
    this.nade = nade;
  }

  /**
   * Decodes a batch of latent vectors, `z`.
   *
   * If `nade` is parameterized, samples are generated using the MAP (argmax) of
   * the Bernoulli random variables from the NADE, and these bit vector makes up
   * the final dimension of the output.
   *
   * If `nade` is not parameterized, sample labels are generated using the
   * MAP (argmax) of the logits output by the LSTM, and the onehots of those
   * labels makes up the final dimension of the output.
   *
   * @param z A batch of latent vectors to decode, sized `[batchSize, zDims]`.
   * @param length The length of decoded sequences.
   * @param temperature The softmax temperature to use when sampling from the
   * logits. Argmax is used if not provided.
   *
   * @returns A boolean tensor containing the decoded sequences, shaped
   * `[batchSize, length, depth]`.
   */
  decode(
      z: tf.Tensor2D, length: number, initialInput?: tf.Tensor2D,
      temperature?: number) {
    const batchSize = z.shape[0];

    return tf.tidy(() => {
      // Initialize LSTMCells.
      const lstmCell =
          initLstmCells(z, this.lstmCellVars, this.zToInitStateVars);

      // Generate samples.
      const samples: tf.Tensor2D[] = [];
      let nextInput = initialInput ?
          initialInput :
          tf.zeros([batchSize, this.outputDims]) as tf.Tensor2D;
      for (let i = 0; i < length; ++i) {
        [lstmCell.c, lstmCell.h] = tf.multiRNNCell(
            lstmCell.cell, tf.concat([nextInput, z], 1), lstmCell.c,
            lstmCell.h);
        const logits =
            dense(this.outputProjectVars, lstmCell.h[lstmCell.h.length - 1]);

        let timeSamples: tf.Tensor2D;
        if (this.nade == null) {
          const timeLabels =
              (temperature ?
                   tf.multinomial(logits.div(tf.scalar(temperature)), 1)
                       .as1D() :
                   logits.argMax(1).as1D());
          nextInput = tf.oneHot(timeLabels, this.outputDims).toFloat();
          timeSamples = nextInput.toBool();
        } else {
          const [encBias, decBias] =
              tf.split(logits, [this.nade.numHidden, this.nade.numDims], 1);
          nextInput =
              this.nade.sample(encBias as tf.Tensor2D, decBias as tf.Tensor2D);
          timeSamples = nextInput.toBool();
        }
        samples.push(timeSamples);
      }

      return tf.stack(samples, 1) as tf.Tensor3D;
    });
  }
}

/**
 * Hierarchical decoder that produces intermediate embeddings to pass to
 * lower-level `Decoder` objects. The outputs from different decoders are
 * concatenated depth-wise (axis 3), and the outputs from different steps of the
 * conductor are concatenated across time (axis 1).
 */
class ConductorDecoder extends Decoder {
  coreDecoders: Decoder[];
  lstmCellVars: LayerVars[];
  zToInitStateVars: LayerVars;
  numSteps: number;
  zDims: number;
  outputDims: number;

  /**
   * `Decoder` contructor.
   * @param coreDecoders Lower-level `Decoder` objects to pass the conductor
   * LSTM output embeddings to for futher decoding.
   * @param lstmCellVars The `LayerVars` for each layer of the conductor LSTM.
   * @param zToInitStateVars The `LayerVars` for projecting from the latent
   * variable `z` to the initial states of the conductor LSTM layers.
   * @param numSteps The number of embeddings the conductor LSTM should produce
   * and pass to the lower-level decoder.
   */
  constructor(
      coreDecoders: Decoder[], lstmCellVars: LayerVars[],
      zToInitStateVars: LayerVars, numSteps: number) {
    super();
    this.coreDecoders = coreDecoders;
    this.lstmCellVars = lstmCellVars;
    this.zToInitStateVars = zToInitStateVars;
    this.numSteps = numSteps;
    this.zDims = this.zToInitStateVars.kernel.shape[0];
    this.outputDims =
        this.coreDecoders.reduce((dims, dec) => dims + dec.outputDims, 0);
  }

  /**
   * Hierarchically decodes a batch of latent vectors, `z`.
   *
   * @param z A batch of latent vectors to decode, sized `[batchSize, zDims]`.
   * @param length The length of decoded sequences.
   * @param temperature The softmax temperature to use when sampling from the
   * logits. Argmax is used if not provided.
   *
   * @returns A boolean tensor containing the decoded sequences, shaped
   * `[batchSize, length, depth]`.
   */
  decode(
      z: tf.Tensor2D, length: number, initialInput?: tf.Tensor2D,
      temperature?: number) {
    const batchSize = z.shape[0];

    return tf.tidy(() => {
      // Initialize LSTMCells.
      const lstmCell =
          initLstmCells(z, this.lstmCellVars, this.zToInitStateVars);

      // Generate embeddings.
      const samples: tf.Tensor3D[] = [];
      let initialInput: tf.Tensor2D[] = this.coreDecoders.map(_ => undefined);
      const dummyInput: tf.Tensor2D = tf.zeros([batchSize, 1]);
      for (let i = 0; i < this.numSteps; ++i) {
        [lstmCell.c, lstmCell.h] =
            tf.multiRNNCell(lstmCell.cell, dummyInput, lstmCell.c, lstmCell.h);
        const currSamples: tf.Tensor3D[] = [];
        for (let j = 0; j < this.coreDecoders.length; ++j) {
          currSamples.push(this.coreDecoders[j].decode(
              lstmCell.h[lstmCell.h.length - 1], length / this.numSteps,
              initialInput[j], temperature));
        }
        samples.push(tf.concat(currSamples, -1));
        initialInput = currSamples.map(
            s => s.slice([0, -1, 0], [batchSize, 1, s.shape[s.rank - 1]])
                     .squeeze([1])
                     .toFloat() as tf.Tensor2D);
      }
      return tf.concat(samples, 1);
    });
  }
}

/**
 * A Neural Autoregressive Distribution Estimator (NADE).
 */
class Nade {
  encWeights: tf.Tensor2D;
  decWeightsT: tf.Tensor2D;
  numDims: number;
  numHidden: number;

  /**
   * `Nade` contructor.
   *
   * @param encWeights The encoder weights (kernel), sized
   * `[numDims, numHidden, 1]`.
   * @param decWeightsT The transposed decoder weights (kernel), sized
   * `[numDims, numHidden, 1]`.
   */
  constructor(encWeights: tf.Tensor3D, decWeightsT: tf.Tensor3D) {
    this.numDims = encWeights.shape[0];
    this.numHidden = encWeights.shape[2];

    this.encWeights = encWeights.as2D(this.numDims, this.numHidden);
    this.decWeightsT = decWeightsT.as2D(this.numDims, this.numHidden);
  }

  /**
   * Samples from the NADE given a batch of encoder and decoder biases.
   *
   * Selects the MAP (argmax) of each Bernoulli random variable.
   *
   * @param encBias A batch of biases to use when encoding, sized
   * `[batchSize, numHidden]`.
   * @param decBias A batch of biases to use when decoding, sized
   * `[batchSize, numDims]`.
   */
  sample(encBias: tf.Tensor2D, decBias: tf.Tensor2D) {
    const batchSize = encBias.shape[0];
    return tf.tidy(() => {
      const samples: tf.Tensor1D[] = [];
      let a = encBias.clone();

      for (let i = 0; i < this.numDims; i++) {
        const h = tf.sigmoid(a);
        const encWeightsI =
            this.encWeights.slice([i, 0], [1, this.numHidden]).as1D();
        const decWeightsTI =
            this.decWeightsT.slice([i, 0], [1, this.numHidden]);
        const decBiasI = decBias.slice([0, i], [batchSize, 1]);
        const contfogitsI =
            decBiasI.add(tf.matMul(h, decWeightsTI, false, true));
        const condProbsI = contfogitsI.sigmoid();

        const samplesI =
            condProbsI.greaterEqual(tf.scalar(0.5)).toFloat().as1D();
        if (i < this.numDims - 1) {
          a = a.add(tf.outerProduct(samplesI.toFloat(), encWeightsI));
        }

        samples.push(samplesI);
      }
      return tf.stack(samples, 1) as tf.Tensor2D;
    });
  }
}

/**
 * Main MusicVAE model class.
 *
 * A MusicVAE is a variational autoencoder made up of an `Encoder` and
 * `Decoder`, along with a `DataConverter` for converting between `Tensor`
 * and `NoteSequence` objects for input and output.
 *
 * Exposes methods for interpolation and sampling of musical sequences.
 */
class MusicVAE {
  private checkpointURL: string;
  private dataConverter: data.DataConverter;
  private encoder: Encoder;
  private decoder: Decoder;
  private rawVars: {[varName: string]: tf.Tensor};  // Store for disposal.
  /**
   * `MusicVAE` constructor.
   *
   * @param checkpointURL Path to the checkpoint directory.
   * @param dataConverter A `DataConverter` object to use for converting between
   * `NoteSequence` and `Tensor` objects. If not provided, a `converter.json`
   * file must exist within the checkpoint directory specifying the type and
   * args for the correct `DataConverter`.
   */
  constructor(checkpointURL: string, dataConverter?: data.DataConverter) {
    this.checkpointURL = checkpointURL;
    this.dataConverter = dataConverter;
  }

  /**
   * Disposes of any untracked `Tensors` to avoid GPU memory leaks.
   */
  dispose() {
    if (!isNullOrUndefined(this.rawVars)) {
      Object.keys(this.rawVars).forEach(name => this.rawVars[name].dispose());
    }
    this.encoder = undefined;
    this.decoder = undefined;
    this.dataConverter = undefined;
  }

  private getLstmLayers(
      cellFormat: string, vars: {[varName: string]: tf.Tensor}) {
    const lstmLayers: LayerVars[] = [];
    let l = 0;
    while (true) {
      const cellPrefix = cellFormat.replace('%d', l.toString());
      if (!(cellPrefix + 'kernel' in vars)) {
        break;
      }
      lstmLayers.push(new LayerVars(
          vars[cellPrefix + 'kernel'] as tf.Tensor2D,
          vars[cellPrefix + 'bias'] as tf.Tensor1D));
      ++l;
    }
    return lstmLayers;
  }

  /**
   * Loads variables from the checkpoint and instantiates the `Encoder` and
   * `Decoder`.
   */
  async initialize() {
    this.dispose();

    const LSTM_CELL_FORMAT = 'cell_%d/lstm_cell/';
    const MUTLI_LSTM_CELL_FORMAT = 'multi_rnn_cell/' + LSTM_CELL_FORMAT;
    const CONDUCTOR_PREFIX = 'decoder/hierarchical_level_0/';
    const BIDI_LSTM_CELL =
        'cell_%d/bidirectional_rnn/%s/multi_rnn_cell/cell_0/lstm_cell/';
    const ENCODER_FORMAT = 'encoder/' + BIDI_LSTM_CELL;
    const HIER_ENCODER_FORMAT =
        'encoder/hierarchical_level_%d/' + BIDI_LSTM_CELL.replace('%d', '0');

    if (isNullOrUndefined(this.dataConverter)) {
      fetch(this.checkpointURL + '/converter.json')
          .then((response) => response.json())
          .then((converterSpec: data.ConverterSpec) => {
            this.dataConverter = data.converterFromSpec(converterSpec);
          });
    }

    const reader = new CheckpointLoader(this.checkpointURL);
    const vars = await reader.getAllVariables();
    this.rawVars = vars;  // Save for disposal.
    // Encoder variables.
    const encMu = new LayerVars(
        vars['encoder/mu/kernel'] as tf.Tensor2D,
        vars['encoder/mu/bias'] as tf.Tensor1D);

    if (this.dataConverter.numSegments) {
      const fwLayers =
          this.getLstmLayers(HIER_ENCODER_FORMAT.replace('%s', 'fw'), vars);
      const bwLayers =
          this.getLstmLayers(HIER_ENCODER_FORMAT.replace('%s', 'bw'), vars);

      if (fwLayers.length !== bwLayers.length || fwLayers.length !== 2) {
        throw Error(
            'Only 2 hierarchical encoder levels are supported. ' +
            `Got ${fwLayers.length} forward and ${bwLayers.length} ` +
            'backward.');
      }
      const baseEncoders: BidirectonalLstmEncoder[] = [0, 1].map(
          l => new BidirectonalLstmEncoder(fwLayers[l], bwLayers[l]));
      this.encoder = new HierarchicalEncoder(
          baseEncoders, [this.dataConverter.numSegments, 1], encMu);
    } else {
      const fwLayers =
          this.getLstmLayers(ENCODER_FORMAT.replace('%s', 'fw'), vars);
      const bwLayers =
          this.getLstmLayers(ENCODER_FORMAT.replace('%s', 'bw'), vars);
      if (fwLayers.length !== bwLayers.length || fwLayers.length !== 1) {
        throw Error(
            'Only single-layer bidirectional encoders are supported. ' +
            `Got ${fwLayers.length} forward and ${bwLayers.length} ` +
            'backward.');
      }
      this.encoder =
          new BidirectonalLstmEncoder(fwLayers[0], bwLayers[0], encMu);
    }

    // BaseDecoder variables.
    const decVarPrefix =
        (this.dataConverter.numSegments) ? 'core_decoder/' : '';

    const decVarPrefixes: string[] = [];
    if (this.dataConverter.NUM_SPLITS) {
      for (let i = 0; i < this.dataConverter.NUM_SPLITS; ++i) {
        decVarPrefixes.push(decVarPrefix + `core_decoder_${i}/decoder/`);
      }
    } else {
      decVarPrefixes.push(decVarPrefix + 'decoder/');
    }

    const baseDecoders = decVarPrefixes.map((varPrefix) => {
      const decLstmLayers =
          this.getLstmLayers(varPrefix + MUTLI_LSTM_CELL_FORMAT, vars);
      const decZtoInitState = new LayerVars(
          vars[varPrefix + 'z_to_initial_state/kernel'] as tf.Tensor2D,
          vars[varPrefix + 'z_to_initial_state/bias'] as tf.Tensor1D);
      const decOutputProjection = new LayerVars(
          vars[varPrefix + 'output_projection/kernel'] as tf.Tensor2D,
          vars[varPrefix + 'output_projection/bias'] as tf.Tensor1D);
      // Optional NADE for the BaseDecoder.
      const nade =
          ((varPrefix + 'nade/w_enc' in vars) ?
               new Nade(
                   vars[varPrefix + 'nade/w_enc'] as tf.Tensor3D,
                   vars[varPrefix + 'nade/w_dec_t'] as tf.Tensor3D) :
               null);
      return new BaseDecoder(
          decLstmLayers, decZtoInitState, decOutputProjection, nade);
    });

    // ConductorDecoder variables.
    if (this.dataConverter.numSegments) {
      const condLstmLayers =
          this.getLstmLayers(CONDUCTOR_PREFIX + LSTM_CELL_FORMAT, vars);
      const condZtoInitState = new LayerVars(
          vars[CONDUCTOR_PREFIX + 'initial_state/kernel'] as tf.Tensor2D,
          vars[CONDUCTOR_PREFIX + 'initial_state/bias'] as tf.Tensor1D);
      this.decoder = new ConductorDecoder(
          baseDecoders, condLstmLayers, condZtoInitState,
          this.dataConverter.numSegments);
    } else if (baseDecoders.length === 1) {
      this.decoder = baseDecoders[0];
    } else {
      throw Error(
          'Unexpected number of base decoders without conductor: ' +
          `${baseDecoders.length}`);
    }

    return this;
  }

  /**
   * @returns true iff an `Encoder` and `Decoder` have been instantiated for the
   * model.
   */
  isInitialized() { return (!!this.encoder && !!this.decoder); }

  /**
   * Interpolates between the input `NoteSequence`s in latent space.
   *
   * If 2 sequences are given, a single linear interpolation is computed, with
   * the first output sequence being a reconstruction of sequence A and the
   * final output being a reconstruction of sequence B, with `numInterps`
   * total sequences.
   *
   * If 4 sequences are given, bilinear interpolation is used. The results are
   * returned in row-major order for a matrix with the following layout:
   *   | A . . C |
   *   | . . . . |
   *   | . . . . |
   *   | B . . D |
   * where the letters represent the reconstructions of the four inputs, in
   * alphabetical order, and there are `numInterps` sequences on each
   * edge for a total of `numInterps`^2 sequences.
   *
   * @param inputSequences An array of 2 or 4 `NoteSequence`s to interpolate
   * between.
   * @param numInterps The number of pairwise interpolation sequences to
   * return, including the reconstructions. If 4 inputs are given, the total
   * number of sequences will be `numInterps`^2.
   *
   * @returns An array of interpolation `NoteSequence` objects, as described
   * above.
   */
  async interpolate(inputSequences: INoteSequence[], numInterps: number) {
    const inputZs = await this.encode(inputSequences);
    const interpZs = tf.tidy(() => this.getInterpolatedZs(inputZs, numInterps));
    inputZs.dispose();

    const outputSequenes = this.decode(interpZs);
    interpZs.dispose();
    return outputSequenes;
  }

  /**
   * Encodes the input `NoteSequence`s into latent vectors.
   *
   * @param inputSequences An array of `NoteSequence`s to encode.
   * @returns A `Tensor` containing the batch of latent vectors, sized
   * `[inputSequences.length, zSize]`.
   */
  async encode(inputSequences: INoteSequence[]) {
    return tf.tidy(() => {
      const inputTensors = tf.stack(inputSequences.map(
          t => this.dataConverter.toTensor(t) as tf.Tensor2D)) as tf.Tensor3D;

      // Use the mean `mu` of the latent variable as the best estimate of `z`.
      return this.encoder.encode(inputTensors);
    });
  }

  /**
   * Decodes the input latnet vectors into `NoteSequence`s.
   *
   * @param z The latent vectors to decode, sized `[batchSize, zSize]`.
   * @param temperature (Optional) The softmax temperature to use when sampling.
   * The argmax is used if not provided.
   *
   * @returns The decoded `NoteSequence`s.
   */
  async decode(z: tf.Tensor2D, temperature?: number) {
    const numSteps = this.dataConverter.numSteps;

    const ohSeqs: tf.Tensor2D[] = tf.tidy(() => {
      const ohSeqs = this.decoder.decode(z, numSteps, undefined, temperature);
      return tf.split(ohSeqs, ohSeqs.shape[0])
          .map(oh => oh.squeeze([0]) as tf.Tensor2D);
    });

    const outputSequences: INoteSequence[] = [];
    for (const oh of ohSeqs) {
      outputSequences.push(await this.dataConverter.toNoteSequence(oh));
      oh.dispose();
    }
    return outputSequences;
  }

  private getInterpolatedZs(z: tf.Tensor2D, numInterps: number) {
    if (z.shape[0] !== 2 && z.shape[0] !== 4) {
      throw new Error(
          'Invalid number of input sequences. Requires length 2, or 4');
    }

    // Compute the interpolations of the latent variable.
    const interpolatedZs: tf.Tensor2D = tf.tidy(() => {
      const rangeArray = tf.linspace(0.0, 1.0, numInterps);

      const z0 = z.slice([0, 0], [1, z.shape[1]]).as1D();
      const z1 = z.slice([1, 0], [1, z.shape[1]]).as1D();

      if (z.shape[0] === 2) {
        const zDiff = z1.sub(z0) as tf.Tensor1D;
        return tf.outerProduct(rangeArray, zDiff).add(z0) as tf.Tensor2D;
      } else if (z.shape[0] === 4) {
        const z2 = z.slice([2, 0], [1, z.shape[1]]).as1D();
        const z3 = z.slice([3, 0], [1, z.shape[1]]).as1D();

        const revRangeArray = tf.scalar(1.0).sub(rangeArray) as tf.Tensor1D;

        const r = numInterps;
        let finalZs =
            z0.mul(tf.outerProduct(revRangeArray, revRangeArray).as3D(r, r, 1));
        finalZs = tf.addStrict(
            finalZs,
            z1.mul(tf.outerProduct(rangeArray, revRangeArray).as3D(r, r, 1)));
        finalZs = tf.addStrict(
            finalZs,
            z2.mul(tf.outerProduct(revRangeArray, rangeArray).as3D(r, r, 1)));
        finalZs = tf.addStrict(
            finalZs,
            z3.mul(tf.outerProduct(rangeArray, rangeArray).as3D(r, r, 1)));

        return finalZs.as2D(r * r, z.shape[1]);
      } else {
        throw new Error(
            'Invalid number of note sequences. Requires length 2, or 4');
      }
    });
    return interpolatedZs;
  }

  /**
   * Samples sequences from the model prior.
   *
   * @param numSamples The number of samples to return.
   * @param temperature The softmax temperature to use when sampling.
   *
   * @returns An array of sampled `NoteSequence` objects.
   */
  async sample(numSamples: number, temperature = 0.5) {
    const randZs: tf.Tensor2D =
        tf.tidy(() => tf.randomNormal([numSamples, this.decoder.zDims]));
    const outputSequenes = this.decode(randZs, temperature);
    randZs.dispose();
    return outputSequenes;
  }
}

export {
  LayerVars,
  Encoder,
  Decoder,
  Nade,
  MusicVAE,
};

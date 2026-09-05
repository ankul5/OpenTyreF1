"""Machine-learning assets for OpenTyreF1.

One model exists in this project: a tyre/lap-time regressor used by the
strategy simulator. `dataset.py` assembles its training frame from the already
ingested SQLite data, `train_tyre_model.py` fits and scores it, and
`predictor.py` is the read-only load path the API uses at request time.
"""

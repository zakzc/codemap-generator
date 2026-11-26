from flask import Blueprint, Flask

app = Flask(__name__)
bp = Blueprint("b", __name__, url_prefix="/bp")


@bp.route("/x", methods=["POST", "PUT"])
def x():
    return ""


@app.route("/")
def index():
    return ""


app.register_blueprint(bp)
